import { describe, expect, it } from "vitest";
import { eventBodySchema, signedEventSchema, SCHEMA_VERSION } from "../src/events.js";

describe("eventBodySchema", () => {
  it("accepts every documented event type", () => {
    const bodies = [
      {
        type: "session_started",
        payload: { sessionId: "s1", agent: "claude-code", sandboxProvider: "e2b" },
      },
      {
        type: "participant_joined",
        payload: { participantId: "p1", displayName: "Alice", role: "observer" },
      },
      { type: "participant_left", payload: { participantId: "p1" } },
      { type: "role_changed", payload: { participantId: "p1", role: "navigator" } },
      { type: "control_handoff", payload: { fromParticipantId: "p1", toParticipantId: "p2" } },
      { type: "agent_message_chunk", payload: { text: "" } },
      { type: "tool_call", payload: { toolCallId: "t1", title: "Run tests", status: "pending" } },
      {
        type: "tool_call_update",
        payload: { toolCallId: "t1", status: "completed", output: "ok" },
      },
      { type: "human_message", payload: { text: "stop", delivery: "interrupt" } },
      {
        type: "permission_request",
        payload: {
          requestId: "r1",
          toolCallId: "t1",
          title: "Run rm -rf",
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      },
      {
        type: "permission_decision",
        payload: { requestId: "r1", outcome: { kind: "selected", optionId: "allow" } },
      },
      { type: "turn_ended", payload: { stopReason: "cancelled" } },
      {
        type: "checkpoint",
        payload: {
          summary: "100 earlier events (seq 0–99)",
          roster: [{ participantId: "p1", displayName: "Alice", role: "driver" }],
          driverId: "p1",
          pendingPermissions: [],
          snapshotRef: "r2://snap/1",
        },
      },
      {
        type: "checkpoint",
        payload: {
          summary: "100 earlier events (seq 0–99)",
          roster: [],
          driverId: null,
          pendingPermissions: [],
        },
      },
    ];
    for (const body of bodies) {
      expect(eventBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  it("rejects unknown event types", () => {
    expect(eventBodySchema.safeParse({ type: "rm_rf", payload: {} }).success).toBe(false);
  });

  it("rejects an invalid role in participant_joined", () => {
    const body = {
      type: "participant_joined",
      payload: { participantId: "p1", displayName: "Eve", role: "admin" },
    };
    expect(eventBodySchema.safeParse(body).success).toBe(false);
  });

  it("rejects an empty human message", () => {
    const body = { type: "human_message", payload: { text: "", delivery: "queue" } };
    expect(eventBodySchema.safeParse(body).success).toBe(false);
  });

  it("rejects an invalid delivery mode", () => {
    const body = { type: "human_message", payload: { text: "hi", delivery: "broadcast" } };
    expect(eventBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("signedEventSchema", () => {
  const valid = {
    v: SCHEMA_VERSION,
    seq: 0,
    ts: 1000,
    authorId: "system",
    body: { type: "participant_left", payload: { participantId: "p1" } },
    prevHash: "0".repeat(64),
    hash: "a".repeat(64),
  };

  it("accepts a well-formed signed event", () => {
    expect(signedEventSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects malformed hashes, negative seqs, and wrong versions", () => {
    expect(signedEventSchema.safeParse({ ...valid, hash: "xyz" }).success).toBe(false);
    expect(signedEventSchema.safeParse({ ...valid, prevHash: "0".repeat(63) }).success).toBe(false);
    expect(signedEventSchema.safeParse({ ...valid, seq: -1 }).success).toBe(false);
    expect(signedEventSchema.safeParse({ ...valid, v: 99 }).success).toBe(false);
  });
});
