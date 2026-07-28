import { describe, expect, it } from "vitest";
import { appendEvent, type EventBody, type SignedEvent } from "@side-street/core";
import { deriveSession } from "../src/lib/derive.js";

async function log(entries: Array<{ authorId: string; body: EventBody }>): Promise<SignedEvent[]> {
  const events: SignedEvent[] = [];
  let ts = 0;
  for (const { authorId, body } of entries) {
    events.push(await appendEvent(events, { authorId, body, ts: ts++ }));
  }
  return events;
}

describe("deriveSession", () => {
  it("merges consecutive agent chunks into one timeline item", async () => {
    const events = await log([
      { authorId: "agent", body: { type: "agent_message_chunk", payload: { text: "Hel" } } },
      { authorId: "agent", body: { type: "agent_message_chunk", payload: { text: "lo" } } },
      {
        authorId: "alice",
        body: { type: "human_message", payload: { text: "hi", delivery: "queue" } },
      },
      { authorId: "agent", body: { type: "agent_message_chunk", payload: { text: "More" } } },
    ]);
    const { timeline } = deriveSession(events);
    expect(timeline.map((t) => t.kind)).toEqual(["agent_text", "human", "agent_text"]);
    expect(timeline[0]).toMatchObject({ text: "Hello" });
  });

  it("collapses tool calls to their latest status and captures output", async () => {
    const events = await log([
      {
        authorId: "agent",
        body: {
          type: "tool_call",
          payload: { toolCallId: "t1", title: "Run tests", status: "pending" },
        },
      },
      {
        authorId: "agent",
        body: {
          type: "tool_call_update",
          payload: { toolCallId: "t1", status: "completed", output: "12 passed" },
        },
      },
    ]);
    const { timeline } = deriveSession(events);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      kind: "tool",
      title: "Run tests",
      status: "completed",
      output: "12 passed",
    });
  });

  it("tracks roster, roles-at-message-time, and the wheel", async () => {
    const events = await log([
      {
        authorId: "alice",
        body: {
          type: "participant_joined",
          payload: { participantId: "alice", displayName: "Alice", role: "driver" },
        },
      },
      {
        authorId: "bob",
        body: {
          type: "participant_joined",
          payload: { participantId: "bob", displayName: "Bob", role: "navigator" },
        },
      },
      {
        authorId: "alice",
        body: {
          type: "control_handoff",
          payload: { fromParticipantId: "alice", toParticipantId: "alice" },
        },
      },
      {
        authorId: "bob",
        body: { type: "human_message", payload: { text: "suggestion", delivery: "queue" } },
      },
      {
        authorId: "alice",
        body: { type: "participant_left", payload: { participantId: "alice" } },
      },
    ]);
    const { roster, driverId, timeline } = deriveSession(events);
    expect(roster.map((r) => r.id)).toEqual(["bob"]);
    expect(driverId).toBeNull(); // driver left, wheel freed
    const human = timeline.find((t) => t.kind === "human");
    expect(human).toMatchObject({ authorId: "bob", role: "navigator" });
  });

  it("surfaces non-natural turn ends and hides end_turn noise", async () => {
    const events = await log([
      { authorId: "agent", body: { type: "turn_ended", payload: { stopReason: "end_turn" } } },
      { authorId: "agent", body: { type: "turn_ended", payload: { stopReason: "cancelled" } } },
    ]);
    const { timeline } = deriveSession(events);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "system", text: "turn ended (cancelled)" });
  });

  it("tracks a permission request as pending until its decision arrives", async () => {
    const request: EventBody = {
      type: "permission_request",
      payload: {
        requestId: "perm-1",
        toolCallId: "tc-1",
        title: "Run rm -rf build",
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
        stepId: "0123456789abcdef",
        priorAttempts: 0,
      },
    };
    const requested = await log([{ authorId: "agent", body: request }]);
    const afterRequest = deriveSession(requested);
    expect(afterRequest.pendingPermissions).toEqual([
      {
        requestId: "perm-1",
        title: "Run rm -rf build",
        options: request.payload.options,
        priorAttempts: 0,
      },
    ]);
    expect(afterRequest.timeline.at(-1)).toMatchObject({
      kind: "system",
      text: "🔒 approval requested: Run rm -rf build",
    });

    const decided = await log([
      { authorId: "agent", body: request },
      {
        authorId: "alice",
        body: {
          type: "permission_decision",
          payload: { requestId: "perm-1", outcome: { kind: "selected", optionId: "allow" } },
        },
      },
    ]);
    const afterDecision = deriveSession(decided);
    expect(afterDecision.pendingPermissions).toEqual([]); // no longer pending
    expect(afterDecision.timeline.at(-1)).toMatchObject({ text: "🔓 tool approved (allow)" });
  });
  it("restores state from a checkpoint the stream opens with", async () => {
    const events = await log([
      {
        authorId: "system",
        body: {
          type: "checkpoint",
          payload: {
            summary: "100 earlier events (seq 0–99)",
            roster: [
              { participantId: "alice", displayName: "Alice", role: "driver" },
              { participantId: "bob", displayName: "Bob", role: "observer" },
            ],
            driverId: "alice",
            pendingPermissions: [
              {
                requestId: "perm-1",
                toolCallId: "tc-1",
                title: "Run rm -rf build",
                options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
                stepId: "0123456789abcdef",
                priorAttempts: 1,
              },
            ],
          },
        },
      },
      {
        authorId: "alice",
        body: { type: "human_message", payload: { text: "carry on", delivery: "queue" } },
      },
    ]);
    const derived = deriveSession(events);
    // The elided history is gone, but everything it determined survives.
    expect(derived.roster.map((p) => p.displayName)).toEqual(["Alice", "Bob"]);
    expect(derived.driverId).toBe("alice");
    expect(derived.pendingPermissions.map((p) => p.requestId)).toEqual(["perm-1"]);
    // The repeat warning has to survive compaction too — it is the reason a
    // late-joining Driver would hesitate before approving.
    expect(derived.pendingPermissions[0]?.priorAttempts).toBe(1);
    expect(derived.timeline[0]).toMatchObject({
      kind: "system",
      text: "⋯ 100 earlier events (seq 0–99)",
    });
    // Attribution still resolves for events after the gap.
    expect(derived.timeline[1]).toMatchObject({ kind: "human", authorId: "alice", role: "driver" });
  });

  it("does not mark a gap for a checkpoint reached live", async () => {
    const events = await log([
      {
        authorId: "alice",
        body: {
          type: "participant_joined",
          payload: { participantId: "alice", displayName: "Alice", role: "driver" },
        },
      },
      {
        authorId: "system",
        body: {
          type: "checkpoint",
          payload: {
            summary: "100 earlier events (seq 0–99)",
            roster: [{ participantId: "alice", displayName: "Alice", role: "driver" }],
            driverId: "alice",
            pendingPermissions: [],
          },
        },
      },
    ]);
    const { timeline, roster } = deriveSession(events);
    expect(timeline.map((t) => t.kind)).toEqual(["system"]);
    expect(timeline[0]).toMatchObject({ text: "Alice joined as driver" });
    expect(roster).toHaveLength(1);
  });
  it("clears a pending approval the agent restart orphaned", async () => {
    const events = await log([
      {
        authorId: "agent",
        body: {
          type: "permission_request",
          payload: {
            requestId: "perm-1",
            toolCallId: "tc-1",
            title: "Post the release notes",
            options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
            stepId: "0123456789abcdef",
            priorAttempts: 0,
          },
        },
      },
      {
        authorId: "system",
        body: {
          type: "step_unresolved",
          payload: {
            requestId: "perm-1",
            stepId: "0123456789abcdef",
            title: "Post the release notes",
            state: "approved_unfinished",
            idempotencyKey: { sessionId: "s1", stepId: "0123456789abcdef", attempt: 1 },
          },
        },
      },
    ]);
    const { timeline, pendingPermissions } = deriveSession(events);
    // No dead button to click, and the timeline says why.
    expect(pendingPermissions).toEqual([]);
    expect(timeline.at(-1)).toMatchObject({
      kind: "system",
      text: expect.stringContaining("approved but never finished (attempt 1)") as unknown as string,
    });
  });
});
