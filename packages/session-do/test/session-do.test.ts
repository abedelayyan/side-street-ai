import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyChain, type SignedEvent } from "@side-street/core";

const BASE = "https://session.test";

interface CollectedSocket {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  waitFor(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

async function connect(path: string): Promise<CollectedSocket> {
  const response = await SELF.fetch(`${BASE}${path}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("no websocket on response");
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }> = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    frames.push(frame);
    const index = waiters.findIndex((w) => w.predicate(frame));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter!.resolve(frame);
    }
  });
  return {
    ws,
    frames,
    waitFor(predicate) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        waiters.push({ predicate, resolve });
        setTimeout(() => reject(new Error("timed out waiting for frame")), 2000);
      });
    },
  };
}

function viewerPath(sessionId: string, id: string, role: string): string {
  return `/session/${sessionId}/ws?participantId=${id}&displayName=${id}&role=${role}`;
}

function isEventOf(type: string) {
  return (frame: Record<string, unknown>): boolean =>
    frame["type"] === "event" && (frame["event"] as { body: { type: string } }).body.type === type;
}

let sessionCounter = 0;
function freshSession(): string {
  return `s${Date.now()}-${sessionCounter++}`;
}

describe("routing", () => {
  it("404s unknown paths and rejects non-upgrade ws requests", async () => {
    expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/session/abc/ws?x=1`)).status).toBe(426);
  });

  it("rejects invalid join parameters and bad replay offsets", async () => {
    const bad = await SELF.fetch(`${BASE}/session/abc/ws?participantId=a&role=admin`, {
      headers: { Upgrade: "websocket" },
    });
    expect(bad.status).toBe(400);
    expect((await SELF.fetch(`${BASE}/session/abc/events?from=-1`)).status).toBe(400);
  });
});

describe("session lifecycle over WebSocket", () => {
  it("welcomes a joiner and streams attributed steering to all viewers", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    const welcome = await alice.waitFor((f) => f["type"] === "welcome");
    expect(welcome).toMatchObject({ participantId: "alice", role: "driver" });

    const bob = await connect(viewerPath(sessionId, "bob", "observer"));
    await bob.waitFor((f) => f["type"] === "welcome");

    // Alice takes the wheel and steers; Bob sees both events live.
    alice.ws.send(JSON.stringify({ type: "handoff", toParticipantId: "alice" }));
    await bob.waitFor(isEventOf("control_handoff"));
    alice.ws.send(
      JSON.stringify({ type: "steer", id: "m1", text: "fix the flaky test", delivery: "queue" }),
    );
    const humanEvent = await bob.waitFor(isEventOf("human_message"));
    expect((humanEvent["event"] as { authorId: string }).authorId).toBe("alice");
  });

  it("privately rejects observer steering without broadcasting", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");
    const carol = await connect(viewerPath(sessionId, "carol", "observer"));
    await carol.waitFor((f) => f["type"] === "welcome");

    carol.ws.send(
      JSON.stringify({ type: "steer", id: "m9", text: "try again", delivery: "queue" }),
    );
    const rejection = await carol.waitFor((f) => f["type"] === "steer_rejected");
    expect(rejection).toMatchObject({ messageId: "m9", reason: "observers are read-only" });
    expect(alice.frames.filter(isEventOf("human_message"))).toHaveLength(0);
  });

  it("answers malformed frames with an error frame", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");
    alice.ws.send("not json");
    const error = await alice.waitFor((f) => f["type"] === "error");
    expect(error["message"]).toBe("frame is not valid JSON");
  });
});

describe("agent bridge", () => {
  it("forwards driver prompts to the agent socket and agent events to viewers", async () => {
    const sessionId = freshSession();
    const agent = await connect(`/session/${sessionId}/agent`);
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");

    alice.ws.send(JSON.stringify({ type: "handoff", toParticipantId: "alice" }));
    alice.ws.send(
      JSON.stringify({ type: "steer", id: "m1", text: "run tests", delivery: "queue" }),
    );
    const prompt = await agent.waitFor((f) => f["type"] === "prompt");
    expect(prompt["messages"]).toEqual([
      expect.objectContaining({ authorId: "alice", text: "run tests" }),
    ]);

    agent.ws.send(
      JSON.stringify({
        type: "agent_event",
        body: { type: "agent_message_chunk", payload: { text: "Running..." } },
      }),
    );
    await alice.waitFor(isEventOf("agent_message_chunk"));
    agent.ws.send(JSON.stringify({ type: "turn_ended", stopReason: "end_turn" }));
    await alice.waitFor(isEventOf("turn_ended"));
  });

  it("buffers prompts while the agent bridge is down and flushes on connect", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");
    alice.ws.send(JSON.stringify({ type: "handoff", toParticipantId: "alice" }));
    alice.ws.send(
      JSON.stringify({ type: "steer", id: "m1", text: "queued while offline", delivery: "queue" }),
    );
    await alice.waitFor(isEventOf("human_message"));

    const agent = await connect(`/session/${sessionId}/agent`);
    const prompt = await agent.waitFor((f) => f["type"] === "prompt");
    expect(prompt["messages"]).toEqual([expect.objectContaining({ text: "queued while offline" })]);
  });
});

describe("replay", () => {
  it("serves a verifiable tail from any offset", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");
    alice.ws.send(JSON.stringify({ type: "handoff", toParticipantId: "alice" }));
    alice.ws.send(JSON.stringify({ type: "steer", id: "m1", text: "go", delivery: "queue" }));
    await alice.waitFor(isEventOf("human_message"));

    const full = await SELF.fetch(`${BASE}/session/${sessionId}/events?from=0`);
    const { events } = (await full.json()) as { events: SignedEvent[] };
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(await verifyChain(events)).toEqual({ valid: true, length: events.length });

    const tailResponse = await SELF.fetch(`${BASE}/session/${sessionId}/events?from=2`);
    const { events: tail } = (await tailResponse.json()) as { events: SignedEvent[] };
    expect(tail).toEqual(events.filter((e) => e.seq >= 2));
    expect(await verifyChain(tail, events[1]!.hash)).toEqual({ valid: true, length: tail.length });
  });
});
