import { describe, expect, it } from "vitest";
import { GENESIS_HASH, appendEvent, verifyChain } from "../src/hash-chain.js";
import type { EventBody, SignedEvent } from "../src/events.js";

async function buildLog(): Promise<SignedEvent[]> {
  const bodies: Array<{ authorId: string; body: EventBody }> = [
    {
      authorId: "system",
      body: {
        type: "session_started",
        payload: { sessionId: "s1", agent: "claude-code", sandboxProvider: "e2b" },
      },
    },
    {
      authorId: "alice",
      body: {
        type: "participant_joined",
        payload: { participantId: "alice", displayName: "Alice", role: "driver" },
      },
    },
    {
      authorId: "alice",
      body: { type: "human_message", payload: { text: "fix the failing test", delivery: "queue" } },
    },
    {
      authorId: "agent",
      body: { type: "agent_message_chunk", payload: { text: "Looking at the test..." } },
    },
  ];

  const log: SignedEvent[] = [];
  let ts = 1_000;
  for (const { authorId, body } of bodies) {
    log.push(await appendEvent(log, { authorId, body, ts: ts++ }));
  }
  return log;
}

describe("appendEvent", () => {
  it("starts at seq 0 with the genesis prevHash", async () => {
    const log = await buildLog();
    expect(log[0]!.seq).toBe(0);
    expect(log[0]!.prevHash).toBe(GENESIS_HASH);
  });

  it("links each event to its predecessor's hash with contiguous seqs", async () => {
    const log = await buildLog();
    for (let i = 1; i < log.length; i++) {
      expect(log[i]!.seq).toBe(i);
      expect(log[i]!.prevHash).toBe(log[i - 1]!.hash);
    }
  });

  it("is deterministic: identical input yields identical hashes", async () => {
    const [a, b] = [await buildLog(), await buildLog()];
    expect(a.map((e) => e.hash)).toEqual(b.map((e) => e.hash));
  });
});

describe("verifyChain", () => {
  it("accepts an empty log and a valid log", async () => {
    expect(await verifyChain([])).toEqual({ valid: true, length: 0 });
    expect(await verifyChain(await buildLog())).toEqual({ valid: true, length: 4 });
  });

  it("detects a tampered payload at the exact seq", async () => {
    const log = await buildLog();
    const tampered = structuredClone(log);
    tampered[2]!.body = {
      type: "human_message",
      payload: { text: "delete all the tests", delivery: "queue" },
    };
    const result = await verifyChain(tampered);
    expect(result).toEqual({ valid: false, firstInvalidSeq: 2, reason: "hash mismatch" });
  });

  it("detects a tampered author (attribution rewrite)", async () => {
    const log = await buildLog();
    const tampered = structuredClone(log);
    tampered[2]!.authorId = "bob";
    const result = await verifyChain(tampered);
    expect(result).toMatchObject({ valid: false, firstInvalidSeq: 2 });
  });

  it("detects a recomputed hash that breaks the downstream link", async () => {
    const log = await buildLog();
    const tampered = structuredClone(log);
    // Attacker rewrites event 1 AND recomputes its hash; event 2's prevHash no longer matches.
    tampered[1]!.body = {
      type: "participant_joined",
      payload: { participantId: "mallory", displayName: "Mallory", role: "driver" },
    };
    const { appendEvent: append } = await import("../src/hash-chain.js");
    const resigned = await append([tampered[0]!], {
      authorId: tampered[1]!.authorId,
      body: tampered[1]!.body,
      ts: tampered[1]!.ts,
    });
    tampered[1] = resigned;
    const result = await verifyChain(tampered);
    expect(result).toEqual({ valid: false, firstInvalidSeq: 2, reason: "broken prevHash link" });
  });

  it("detects reordered events", async () => {
    const log = await buildLog();
    const reordered = [log[0]!, log[2]!, log[1]!, log[3]!];
    const result = await verifyChain(reordered);
    expect(result.valid).toBe(false);
  });

  it("detects a dropped event", async () => {
    const log = await buildLog();
    const dropped = [log[0]!, log[1]!, log[3]!];
    const result = await verifyChain(dropped);
    expect(result).toMatchObject({ valid: false, firstInvalidSeq: 3 });
  });

  it("verifies a tail slice given the preceding hash", async () => {
    const log = await buildLog();
    const tail = log.slice(2);
    expect(await verifyChain(tail, log[1]!.hash)).toEqual({ valid: true, length: 2 });
    expect((await verifyChain(tail)).valid).toBe(false);
  });

  it("rejects malformed events", async () => {
    const log = await buildLog();
    const tampered = structuredClone(log) as unknown as Array<Record<string, unknown>>;
    tampered[3]!["hash"] = "not-a-hash";
    const result = await verifyChain(tampered as unknown as SignedEvent[]);
    expect(result).toMatchObject({ valid: false, firstInvalidSeq: 3, reason: "malformed event" });
  });
});
