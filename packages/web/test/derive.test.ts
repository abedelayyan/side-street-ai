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
});
