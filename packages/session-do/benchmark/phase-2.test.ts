/**
 * Phase 2 exit benchmark, automated (docs/benchmarks/phase-2.md).
 *
 * PLAN.md: "the red-team suite passes — no injection path exfiltrates a
 * secret to an Observer; a session survives DO eviction, sandbox
 * pause/resume, and 24h of wall-clock time with replay intact."
 *
 * The red-team half is permanent CI (`test/red-team.test.ts`). This drives
 * the durability half against a *running* Worker — deployed, or `wrangler
 * dev` — because eviction, hibernation and wall-clock are properties of the
 * platform, not of the in-process test runtime.
 *
 * The phases share one live session and run in order. Skipped entirely
 * unless SIDE_STREET_BASE_URL is set, so `pnpm test` stays fast and offline.
 */

import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH, type SignedEvent } from "@side-street/core";

const BASE_URL = (process.env["SIDE_STREET_BASE_URL"] ?? "").replace(/\/$/, "");
/** Total soak duration. 86400000 (24h) is the real phase-exit run. */
const SOAK_MS = Number(process.env["SIDE_STREET_SOAK_MS"] ?? 60_000);
/** Quiet window used to provoke a Durable Object eviction. */
const IDLE_MS = Number(process.env["SIDE_STREET_IDLE_MS"] ?? 30_000);
/**
 * Optional command that bounces the Worker (e.g. restarting `wrangler dev`).
 * Set it and the eviction phase is a certainty rather than a likelihood —
 * the process holding every in-memory instance is gone, so anything the
 * session still knows came out of durable storage.
 */
const RESTART_CMD = process.env["SIDE_STREET_RESTART_CMD"] ?? "";
/**
 * Work is spread over ~500 rounds however long the soak is, so a 24h run
 * costs the same traffic as a 1-minute one and only the gaps get longer.
 * The gaps are the point: they are when a DO is evicted and a socket
 * hibernates.
 */
const ROUNDS = 500;
const ROUND_MS = Math.max(2_000, Math.floor(SOAK_MS / ROUNDS));
const EVENTS_PER_ROUND = 10;

const sessionId = `bench-${Date.now().toString(36)}`;
/** Random per run: a real credential must never live in the repo. */
const CREDENTIAL = `bench-cred-${crypto.randomUUID()}`;

interface Socket {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  send(frame: unknown): void;
  close(): void;
}

async function connect(path: string): Promise<Socket> {
  const ws = new WebSocket(`${BASE_URL.replace(/^http/, "ws")}${path}`);
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }> = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    frames.push(frame);
    const index = waiters.findIndex((w) => w.predicate(frame));
    if (index >= 0) {
      waiters.splice(index, 1)[0]?.resolve(frame);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`cannot connect to ${path}`)), {
      once: true,
    });
  });
  return {
    ws,
    frames,
    waitFor(predicate, timeoutMs = 15_000) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        waiters.push({ predicate, resolve });
        setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
      });
    },
    send(frame) {
      ws.send(JSON.stringify(frame));
    },
    close() {
      ws.close();
    },
  };
}

function viewerPath(id: string, role: string): string {
  return `/session/${sessionId}/ws?participantId=${id}&displayName=${id}&role=${role}`;
}

function isEventOf(type: string) {
  return (frame: Record<string, unknown>): boolean =>
    frame["type"] === "event" && (frame["event"] as SignedEvent).body.type === type;
}

async function replay(from: string | number): Promise<SignedEvent[]> {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/events?from=${from}`);
  expect(response.ok, "replay request failed").toBe(true);
  return ((await response.json()) as { events: SignedEvent[] }).events;
}

async function verifyServerSide(): Promise<{ valid: boolean; length?: number }> {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/verify`);
  return (await response.json()) as { valid: boolean; length?: number };
}

/**
 * Seq contiguity and prevHash linkage — the part of the chain a client can
 * still check when its view has been redacted.
 */
function expectLinked(events: readonly SignedEvent[]): void {
  for (let i = 1; i < events.length; i++) {
    expect(events[i]!.seq).toBe(events[i - 1]!.seq + 1);
    expect(events[i]!.prevHash).toBe(events[i - 1]!.hash);
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until the Worker answers again after a restart. */
async function waitForHealthy(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${BASE_URL}/session/${sessionId}/verify`)).ok) return;
    } catch {
      // Still down.
    }
    if (Date.now() > deadline) throw new Error("Worker did not come back after the restart");
    await wait(1_000);
  }
}

/** Reopen a socket the platform closed during a quiet window. */
async function reopen(socket: Socket, path: string): Promise<Socket> {
  return socket.ws.readyState === WebSocket.OPEN ? socket : await connect(path);
}

describe.skipIf(BASE_URL === "")("Phase 2 exit benchmark", () => {
  let driver: Socket;
  let agent: Socket;

  it("seeds a session and keeps a declared credential off every outbound path", async () => {
    console.log(`session ${sessionId} on ${BASE_URL}`);
    driver = await connect(viewerPath("bench-driver", "driver"));
    const observer = await connect(viewerPath("bench-observer", "observer"));
    await observer.waitFor((f) => f["type"] === "welcome");
    driver.send({ type: "handoff", toParticipantId: "bench-driver" });
    await observer.waitFor(isEventOf("control_handoff"));

    agent = await connect(`/session/${sessionId}/agent`);
    agent.send({ type: "register_secrets", values: [CREDENTIAL] });
    // The agent leaks it every way it can: prose and tool output.
    agent.send({
      type: "agent_event",
      body: { type: "agent_message_chunk", payload: { text: `the token is ${CREDENTIAL}` } },
    });
    agent.send({
      type: "agent_event",
      body: {
        type: "tool_call",
        payload: { toolCallId: "bench-tc-1", title: "Read .env", status: "in_progress" },
      },
    });
    agent.send({
      type: "agent_event",
      body: {
        type: "tool_call_update",
        payload: {
          toolCallId: "bench-tc-1",
          status: "completed",
          output: `TOKEN=${CREDENTIAL}`,
        },
      },
    });
    await observer.waitFor(isEventOf("tool_call_update"));

    expect(JSON.stringify(observer.frames)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(await replay(0))).not.toContain(CREDENTIAL);
    observer.close();
  });

  it("survives a Durable Object eviction with the wheel and the chain intact", async () => {
    const before = await verifyServerSide();
    expect(before.valid).toBe(true);

    if (RESTART_CMD === "") {
      // No restart hook: the quiet window is what provokes eviction. A
      // hibernating socket stays open while the instance behind it is
      // dropped, which is the case worth surviving.
      console.log(`idling ${IDLE_MS}ms to provoke eviction…`);
      await wait(IDLE_MS);
    } else {
      console.log(`restarting the Worker: ${RESTART_CMD}`);
      execSync(RESTART_CMD, { stdio: "inherit" });
      await waitForHealthy();
    }

    driver = await reopen(driver, viewerPath("bench-driver", "driver"));
    driver.send({ type: "steer", id: "after-eviction", text: "still driving", delivery: "queue" });
    // Rebuilt from storage: the roster knows this participant and the wheel
    // is still theirs, or this arrives as a rejection instead.
    const steered = await driver.waitFor(isEventOf("human_message"));
    expect((steered["event"] as SignedEvent).authorId).toBe("bench-driver");
    expect(driver.frames.filter((f) => f["type"] === "steer_rejected")).toHaveLength(0);

    const after = await verifyServerSide();
    expect(after.valid).toBe(true);
    expect(after.length ?? 0).toBeGreaterThan(before.length ?? 0);
  });

  it("survives the sandbox going away mid-step, and says what it cannot account for", async () => {
    // A restart in the previous phase took every socket with it, the agent's
    // included.
    agent = await reopen(agent, `/session/${sessionId}/agent`);
    driver = await reopen(driver, viewerPath("bench-driver", "driver"));
    agent.send({
      type: "permission_request",
      requestId: "bench-perm-1",
      toolCallId: "bench-tc-2",
      title: "Publish the benchmark artifact",
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    });
    await driver.waitFor(isEventOf("permission_request"));
    driver.send({
      type: "decide",
      requestId: "bench-perm-1",
      outcome: { kind: "selected", optionId: "allow" },
    });
    await driver.waitFor(isEventOf("permission_decision"));

    // Sandbox pause/resume, as the session sees it: the bridge dies holding
    // an approved step, and a new one attaches.
    agent.close();
    await wait(1_000);
    agent = await connect(`/session/${sessionId}/agent`);
    const unresolved = await driver.waitFor(isEventOf("step_unresolved"));
    expect((unresolved["event"] as SignedEvent).body).toMatchObject({
      payload: { state: "approved_unfinished", idempotencyKey: { attempt: 1 } },
    });
    expect((await verifyServerSide()).valid).toBe(true);
  });

  it(`keeps replay intact across ${Math.round(SOAK_MS / 1000)}s of wall clock`, async () => {
    const deadline = Date.now() + SOAK_MS;
    let round = 0;
    while (Date.now() < deadline) {
      round++;
      agent = await reopen(agent, `/session/${sessionId}/agent`);
      driver = await reopen(driver, viewerPath("bench-driver", "driver"));
      for (let i = 0; i < EVENTS_PER_ROUND; i++) {
        agent.send({
          type: "agent_event",
          body: { type: "agent_message_chunk", payload: { text: `round ${round} chunk ${i}` } },
        });
      }
      const marker = `round ${round}`;
      driver.send({ type: "steer", id: `soak-${round}`, text: marker, delivery: "queue" });
      // Wait for this round's own message: the session has to be answering
      // now, not merely have answered at some point.
      await driver.waitFor(
        (f) =>
          isEventOf("human_message")(f) &&
          ((f["event"] as SignedEvent).body.payload as { text: string }).text === marker,
      );

      const result = await verifyServerSide();
      expect(result.valid, `chain broke in round ${round}`).toBe(true);
      if (round % 10 === 0) {
        console.log(`round ${round}: ${result.length ?? 0} events, chain valid`);
      }
      await wait(Math.min(ROUND_MS, Math.max(0, deadline - Date.now())));
    }

    // Compaction has to be doing its job by now, or a late joiner in a long
    // session pays for the whole log.
    const full = await replay(0);
    const compacted = await replay("checkpoint");
    console.log(`soak done: ${full.length} events, compacted replay ${compacted.length}`);
    expect(full.length).toBeGreaterThan(EVENTS_PER_ROUND);
    if (full.length > 100) {
      expect(compacted.length).toBeLessThan(full.length);
      expect(compacted[0]?.body.type).toBe("checkpoint");
    }

    // Replay is intact end to end. Hash verification is the *server's*
    // answer here, not ours: this session declared a credential, so replay
    // comes back redacted at the Observer floor, and a redacted event keeps
    // the hash of its canonical form on purpose (packages/redaction) — a
    // viewer shown a secret-free view cannot re-hash it. What a client can
    // still check for itself is that what it received is contiguous and
    // linked, and that the compacted tail hangs off the full log.
    expect((await verifyServerSide()).valid).toBe(true);
    expectLinked(full);
    expectLinked(compacted);
    expect(compacted[0]?.prevHash).toBe(
      full.find((e) => e.seq === (compacted[0]?.seq ?? 0) - 1)?.hash ?? GENESIS_HASH,
    );
    expect(JSON.stringify(full)).not.toContain(CREDENTIAL);

    driver.close();
    agent.close();
  });
});
