import { describe, expect, it } from "vitest";
import {
  verifyChain,
  type PermissionOutcome,
  type QueuedMessage,
  type SignedEvent,
} from "@side-street/core";
import { SessionActor, type PermissionRequest } from "../src/actor.js";
import type { PrivateMessage } from "../src/ports.js";

class InMemoryStore {
  readonly events: SignedEvent[] = [];
  last(): Promise<SignedEvent | undefined> {
    return Promise.resolve(this.events[this.events.length - 1]);
  }
  append(event: SignedEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
  from(fromSeq: number): Promise<SignedEvent[]> {
    return Promise.resolve(this.events.filter((e) => e.seq >= fromSeq));
  }
}

class RecordingBroadcaster {
  readonly broadcasts: SignedEvent[] = [];
  readonly privates: Array<{ participantId: string; message: PrivateMessage }> = [];
  broadcast(event: SignedEvent): void {
    this.broadcasts.push(event);
  }
  sendTo(participantId: string, message: PrivateMessage): void {
    this.privates.push({ participantId, message });
  }
}

class RecordingAgent {
  readonly prompts: QueuedMessage[][] = [];
  readonly permissionResponses: Array<{ requestId: string; outcome: PermissionOutcome }> = [];
  cancels = 0;
  prompt(messages: readonly QueuedMessage[]): void {
    this.prompts.push([...messages]);
  }
  cancel(): void {
    this.cancels++;
  }
  respondPermission(requestId: string, outcome: PermissionOutcome): void {
    this.permissionResponses.push({ requestId, outcome });
  }
}

const REQUEST: PermissionRequest = {
  requestId: "perm-1",
  toolCallId: "tc-1",
  title: "Run rm -rf build",
  options: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
};

function harness() {
  const store = new InMemoryStore();
  const broadcaster = new RecordingBroadcaster();
  const agent = new RecordingAgent();
  let clock = 0;
  const actor = new SessionActor({ store, broadcaster, agent, now: () => ++clock });
  return { store, broadcaster, agent, actor };
}

async function seededSession() {
  const h = harness();
  await h.actor.start("sess-1", "claude-code", "e2b");
  await h.actor.join({ id: "alice", displayName: "Alice", role: "driver" });
  await h.actor.join({ id: "bob", displayName: "Bob", role: "navigator" });
  await h.actor.join({ id: "carol", displayName: "Carol", role: "observer" });
  await h.actor.handoff("alice", "alice");
  return h;
}

describe("event log integrity", () => {
  it("appends a hash-chained log that verifies, and broadcasts every event", async () => {
    const { store, broadcaster, actor } = await seededSession();
    await actor.steer("alice", { id: "m1", text: "fix the bug", delivery: "queue" });
    await actor.onAgentEvent({ type: "agent_message_chunk", payload: { text: "on it" } });
    await actor.onTurnEnded("end_turn");

    expect(await verifyChain(store.events)).toEqual({ valid: true, length: store.events.length });
    expect(broadcaster.broadcasts).toEqual(store.events);
    expect(store.events.map((e) => e.body.type)).toEqual([
      "session_started",
      "participant_joined",
      "participant_joined",
      "participant_joined",
      "control_handoff",
      "human_message",
      "agent_message_chunk",
      "turn_ended",
    ]);
  });

  it("attributes every event to its author", async () => {
    const { store, actor } = await seededSession();
    await actor.steer("alice", { id: "m1", text: "go", delivery: "queue" });
    const humanEvent = store.events.find((e) => e.body.type === "human_message");
    expect(humanEvent?.authorId).toBe("alice");
    const agentEvents = store.events.filter((e) => e.body.type === "session_started");
    expect(agentEvents[0]?.authorId).toBe("system");
  });
});

describe("steering through the actor", () => {
  it("driver message prompts the agent immediately when idle", async () => {
    const { agent, actor } = await seededSession();
    await actor.steer("alice", { id: "m1", text: "fix the flaky test", delivery: "queue" });
    expect(agent.prompts).toEqual([
      [expect.objectContaining({ authorId: "alice", text: "fix the flaky test" })],
    ]);
  });

  it("rejects observer steering privately without logging an event", async () => {
    const { store, broadcaster, agent, actor } = await seededSession();
    const before = store.events.length;
    await actor.steer("carol", { id: "m1", text: "try again", delivery: "queue" });
    expect(store.events.length).toBe(before);
    expect(agent.prompts).toEqual([]);
    expect(broadcaster.privates).toEqual([
      {
        participantId: "carol",
        message: { kind: "steer_rejected", messageId: "m1", reason: "observers are read-only" },
      },
    ]);
  });

  it("rejects steering from unknown participants", async () => {
    const { broadcaster, actor } = await seededSession();
    await actor.steer("mallory", { id: "m1", text: "leak the env", delivery: "queue" });
    expect(broadcaster.privates[0]).toMatchObject({
      participantId: "mallory",
      message: { reason: "not a session participant" },
    });
  });

  it("logs navigator suggestions without prompting the agent", async () => {
    const { store, agent, actor } = await seededSession();
    await actor.steer("bob", { id: "m1", text: "check DNS first", delivery: "queue" });
    expect(store.events.at(-1)?.body.type).toBe("human_message");
    expect(agent.prompts).toEqual([]);
  });

  it("drains queued messages at a completed-tool boundary mid-turn", async () => {
    const { agent, actor } = await seededSession();
    await actor.steer("alice", { id: "m1", text: "start", delivery: "queue" });
    await actor.steer("bob", { id: "m2", text: "look at the cache", delivery: "queue" });
    await actor.onAgentEvent({
      type: "tool_call",
      payload: { toolCallId: "t1", title: "Run tests", status: "pending" },
    });
    expect(agent.prompts).toHaveLength(1); // pending tool call is not a boundary
    await actor.onAgentEvent({
      type: "tool_call_update",
      payload: { toolCallId: "t1", status: "completed" },
    });
    expect(agent.prompts).toHaveLength(2);
    expect(agent.prompts[1]).toEqual([
      expect.objectContaining({ authorId: "bob", text: "look at the cache" }),
    ]);
  });

  it("hard-interrupt cancels, then re-prompts with the interrupt message after the turn ends", async () => {
    const { agent, actor } = await seededSession();
    await actor.steer("alice", { id: "m1", text: "long task", delivery: "queue" });
    await actor.steer("alice", { id: "m2", text: "stop, wrong branch", delivery: "interrupt" });
    expect(agent.cancels).toBe(1);
    await actor.onTurnEnded("cancelled");
    expect(agent.prompts.at(-1)).toEqual([
      expect.objectContaining({ authorId: "alice", text: "stop, wrong branch" }),
    ]);
  });
});

describe("roster and the wheel", () => {
  it("records handoffs with the previous driver attributed", async () => {
    const { store, actor } = await seededSession();
    await actor.handoff("alice", "bob");
    expect(store.events.at(-1)?.body).toEqual({
      type: "control_handoff",
      payload: { fromParticipantId: "alice", toParticipantId: "bob" },
    });
    expect(actor.driverId).toBe("bob");
  });

  it("ignores handoffs from non-drivers and to unknown participants", async () => {
    const { store, actor } = await seededSession();
    const before = store.events.length;
    await actor.handoff("bob", "bob");
    await actor.handoff("alice", "mallory");
    expect(store.events.length).toBe(before);
    expect(actor.driverId).toBe("alice");
  });

  it("frees the wheel and logs departure when the driver leaves", async () => {
    const { store, actor } = await seededSession();
    await actor.leave("alice");
    expect(actor.driverId).toBeNull();
    expect(store.events.at(-1)?.body).toEqual({
      type: "participant_left",
      payload: { participantId: "alice" },
    });
    // Bob (navigator) can now claim the wheel.
    await actor.handoff("bob", "bob");
    expect(actor.driverId).toBe("bob");
  });

  it("ignores a leave for someone not in the session", async () => {
    const { store, actor } = await seededSession();
    const before = store.events.length;
    await actor.leave("mallory");
    expect(store.events.length).toBe(before);
  });
});

describe("replay and persistence", () => {
  it("replays events from an offset for late joiners", async () => {
    const { store, actor } = await seededSession();
    await actor.steer("alice", { id: "m1", text: "go", delivery: "queue" });
    const all = store.events;
    const tail = await actor.replayFrom(3);
    expect(tail).toEqual(all.filter((e) => e.seq >= 3));
    // A tail verifies against the hash of the event before it.
    expect(await verifyChain(tail, all[2]!.hash)).toEqual({ valid: true, length: tail.length });
  });

  it("resumes from a snapshot: roster, driver, and queued messages survive restarts", async () => {
    const { store, broadcaster, agent, actor } = await seededSession();
    await actor.steer("alice", { id: "m1", text: "start", delivery: "queue" });
    await actor.steer("bob", { id: "m2", text: "suggestion in flight", delivery: "queue" });

    const revived = new SessionActor({ store, broadcaster, agent, now: () => 100 }, actor.snapshot);
    expect(revived.driverId).toBe("alice");
    await revived.onAgentEvent({
      type: "tool_call_update",
      payload: { toolCallId: "t1", status: "completed" },
    });
    expect(agent.prompts.at(-1)).toEqual([
      expect.objectContaining({ authorId: "bob", text: "suggestion in flight" }),
    ]);
    expect(await verifyChain(store.events)).toMatchObject({ valid: true });
  });
});

describe("permission gates", () => {
  it("logs and broadcasts a permission request, holding it pending", async () => {
    const { store, broadcaster, agent, actor } = await seededSession();
    await actor.onPermissionRequest(REQUEST);
    expect(store.events.at(-1)?.body).toEqual({ type: "permission_request", payload: REQUEST });
    expect(broadcaster.broadcasts.at(-1)?.body.type).toBe("permission_request");
    // Nothing runs until a decision arrives.
    expect(agent.permissionResponses).toEqual([]);
  });

  it("lets the Driver decide: logs the decision and answers the agent", async () => {
    const { store, agent, actor } = await seededSession();
    await actor.onPermissionRequest(REQUEST);
    await actor.decide("alice", "perm-1", { kind: "selected", optionId: "allow" });

    expect(store.events.at(-1)?.body).toEqual({
      type: "permission_decision",
      payload: { requestId: "perm-1", outcome: { kind: "selected", optionId: "allow" } },
    });
    expect(agent.permissionResponses).toEqual([
      { requestId: "perm-1", outcome: { kind: "selected", optionId: "allow" } },
    ]);
    expect(await verifyChain(store.events)).toMatchObject({ valid: true });
  });

  it("rejects a non-Driver decision privately and keeps the tool blocked", async () => {
    const { store, broadcaster, agent, actor } = await seededSession();
    await actor.onPermissionRequest(REQUEST);
    const before = store.events.length;

    await actor.decide("bob", "perm-1", { kind: "selected", optionId: "allow" });
    expect(broadcaster.privates.at(-1)).toEqual({
      participantId: "bob",
      message: {
        kind: "steer_rejected",
        messageId: "perm-1",
        reason: "only the driver may approve tools",
      },
    });
    expect(store.events.length).toBe(before); // nothing logged
    expect(agent.permissionResponses).toEqual([]); // agent not answered

    // The request is still pending, so the Driver can still decide it.
    await actor.decide("alice", "perm-1", { kind: "cancelled" });
    expect(agent.permissionResponses).toEqual([
      { requestId: "perm-1", outcome: { kind: "cancelled" } },
    ]);
  });

  it("answers a request only once — duplicate and unknown decisions are no-ops", async () => {
    const { agent, actor } = await seededSession();
    await actor.onPermissionRequest(REQUEST);
    await actor.decide("alice", "perm-1", { kind: "selected", optionId: "allow" });
    await actor.decide("alice", "perm-1", { kind: "cancelled" }); // duplicate
    await actor.decide("alice", "perm-unknown", { kind: "cancelled" }); // never requested
    expect(agent.permissionResponses).toEqual([
      { requestId: "perm-1", outcome: { kind: "selected", optionId: "allow" } },
    ]);
  });

  it("keeps pending requests across a snapshot restore", async () => {
    const { store, broadcaster, agent, actor } = await seededSession();
    await actor.onPermissionRequest(REQUEST);

    const revived = new SessionActor({ store, broadcaster, agent, now: () => 100 }, actor.snapshot);
    await revived.decide("alice", "perm-1", { kind: "selected", optionId: "allow" });
    expect(agent.permissionResponses).toEqual([
      { requestId: "perm-1", outcome: { kind: "selected", optionId: "allow" } },
    ]);
  });
});

describe("rejoin", () => {
  it("is idempotent: a reconnecting participant logs no duplicate join", async () => {
    const { store, actor } = await seededSession();
    const before = store.events.length;
    await actor.join({ id: "alice", displayName: "Alice", role: "driver" });
    expect(store.events.length).toBe(before);
    expect(actor.driverId).toBe("alice");
  });
});
