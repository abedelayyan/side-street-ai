import { describe, expect, it } from "vitest";
import { GENESIS_HASH, appendEvent, type SignedEvent } from "@side-street/core";
import { SessionClient, type WebSocketLike } from "../src/lib/session-client.js";

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  private listeners = new Map<string, Array<(event: never) => void>>();
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit("close", {});
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as never);
    }
  }
  receive(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
}

async function makeLog(count: number): Promise<SignedEvent[]> {
  const log: SignedEvent[] = [];
  for (let i = 0; i < count; i++) {
    log.push(
      await appendEvent(log, {
        authorId: "agent",
        body: { type: "agent_message_chunk", payload: { text: `chunk ${i}` } },
        ts: i,
      }),
    );
  }
  return log;
}

interface Harness {
  socket: FakeSocket;
  client: SessionClient;
  received: SignedEvent[];
  statuses: string[];
  rejections: Array<{ messageId: string; reason: string }>;
  fetches: string[];
  resolveReplay(events: SignedEvent[]): void;
}

function harness(): Harness {
  const socket = new FakeSocket();
  const received: SignedEvent[] = [];
  const statuses: string[] = [];
  const rejections: Array<{ messageId: string; reason: string }> = [];
  const fetches: string[] = [];
  let pendingReplay: ((events: SignedEvent[]) => void) | undefined;

  const client = new SessionClient({
    baseUrl: "http://worker.test",
    sessionId: "s1",
    participantId: "alice",
    displayName: "Alice",
    role: "driver",
    onEvent: (e) => received.push(e),
    onStatus: (s) => statuses.push(s),
    onRejection: (messageId, reason) => rejections.push({ messageId, reason }),
    createSocket: () => socket,
    fetchFn: (url) => {
      fetches.push(url);
      return new Promise((resolve) => {
        pendingReplay = (events) => resolve({ ok: true, json: () => Promise.resolve({ events }) });
      });
    },
  });
  client.connect();
  return {
    socket,
    client,
    received,
    statuses,
    rejections,
    fetches,
    resolveReplay: (events) => pendingReplay?.(events),
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("SessionClient", () => {
  it("replays the tail on welcome, then goes live", async () => {
    const h = harness();
    const log = await makeLog(3);
    h.socket.receive({ type: "welcome", participantId: "alice", role: "driver", lastSeq: 2 });
    expect(h.fetches).toEqual(["http://worker.test/session/s1/events?from=0"]);
    h.resolveReplay(log);
    await flush();
    expect(h.received.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(h.statuses).toEqual(["connecting", "replaying", "live"]);
  });

  it("buffers live frames during replay and deduplicates overlap", async () => {
    const h = harness();
    const log = await makeLog(4);
    h.socket.receive({ type: "welcome", participantId: "alice", role: "driver", lastSeq: 2 });
    // Events 2 and 3 arrive live while the tail (0..2) is still in flight.
    h.socket.receive({ type: "event", event: log[2] });
    h.socket.receive({ type: "event", event: log[3] });
    h.resolveReplay(log.slice(0, 3));
    await flush();
    expect(h.received.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("skips replay entirely when already caught up", async () => {
    const h = harness();
    const log = await makeLog(2);
    h.socket.receive({ type: "welcome", participantId: "alice", role: "driver", lastSeq: 1 });
    h.resolveReplay(log);
    await flush();

    // Reconnect with no new events: welcome's lastSeq equals our cursor.
    h.client.connect();
    h.socket.receive({ type: "welcome", participantId: "alice", role: "driver", lastSeq: 1 });
    await flush();
    expect(h.fetches).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe("live");
  });

  it("resumes a reconnect from the cursor, fetching only the delta", async () => {
    const h = harness();
    const log = await makeLog(5);
    h.socket.receive({ type: "welcome", participantId: "alice", role: "driver", lastSeq: 2 });
    h.resolveReplay(log.slice(0, 3));
    await flush();

    h.client.connect();
    h.socket.receive({ type: "welcome", participantId: "alice", role: "driver", lastSeq: 4 });
    expect(h.fetches[1]).toBe("http://worker.test/session/s1/events?from=3");
    h.resolveReplay(log.slice(3));
    await flush();
    expect(h.received.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("routes steering frames out and rejections back", async () => {
    const h = harness();
    const id = h.client.steer("fix it", "queue");
    h.client.takeWheel();
    expect(h.socket.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "steer", id, text: "fix it", delivery: "queue" },
      { type: "handoff", toParticipantId: "alice" },
    ]);
    h.socket.receive({ type: "steer_rejected", messageId: id, reason: "observers are read-only" });
    expect(h.rejections).toEqual([{ messageId: id, reason: "observers are read-only" }]);
  });

  it("ignores events at or below the cursor (no duplicates to the UI)", async () => {
    const h = harness();
    const log = await makeLog(2);
    h.socket.receive({ type: "welcome", participantId: "alice", role: "driver", lastSeq: 1 });
    h.resolveReplay(log);
    await flush();
    h.socket.receive({ type: "event", event: log[1] });
    expect(h.received).toHaveLength(2);
  });

  it("verifies genesis linkage of the very first delivered event", async () => {
    const h = harness();
    const log = await makeLog(1);
    h.socket.receive({ type: "welcome", participantId: "alice", role: "driver", lastSeq: 0 });
    h.resolveReplay(log);
    await flush();
    expect(h.received[0]?.prevHash).toBe(GENESIS_HASH);
  });
});
