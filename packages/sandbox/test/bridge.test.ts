import { describe, expect, it } from "vitest";
import type { AgentFrame, QueuedMessage } from "@side-street/core";
import { AcpClient, FakeAgent, createTransportPair } from "@side-street/acp-client";
import type { ContentBlock, StopReason } from "@side-street/acp-client";
import { AgentBridge, formatPrompt, type PromptingAgent } from "../src/bridge.js";

function qm(authorId: string, role: QueuedMessage["role"], text: string): QueuedMessage {
  return { id: `${authorId}-${text}`, authorId, role, text, queuedAt: 1 };
}

class FakeSocket {
  readonly sent: AgentFrame[] = [];
  private handler: ((frame: unknown) => void) | undefined;
  send(frame: AgentFrame): void {
    this.sent.push(frame);
  }
  onFrame(handler: (frame: unknown) => void): void {
    this.handler = handler;
  }
  emit(frame: unknown): void {
    this.handler?.(frame);
  }
  turnEnds(): AgentFrame[] {
    return this.sent.filter((f) => f.type === "turn_ended");
  }
}

/** A hand-cranked agent: each prompt() waits until the test resolves it. */
class ScriptedAgent implements PromptingAgent {
  readonly prompts: ContentBlock[][] = [];
  cancels = 0;
  private resolvers: Array<(stop: StopReason) => void> = [];

  prompt(_sessionId: string, prompt: ContentBlock[]): Promise<StopReason> {
    this.prompts.push(prompt);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  cancel(): void {
    this.cancels++;
  }

  async endTurn(stopReason: StopReason): Promise<void> {
    const resolve = this.resolvers.shift();
    if (!resolve) throw new Error("no prompt in flight");
    resolve(stopReason);
    await new Promise((r) => setTimeout(r, 0));
  }
}

function harness() {
  const socket = new FakeSocket();
  const agent = new ScriptedAgent();
  const errors: Error[] = [];
  const bridge = new AgentBridge({
    socket,
    agent,
    acpSessionId: "acp-1",
    onError: (e) => errors.push(e),
  });
  return { socket, agent, errors, bridge };
}

describe("formatPrompt", () => {
  it("keeps driver text verbatim and labels suggestions with their author", () => {
    expect(
      formatPrompt([qm("alice", "driver", "fix the test"), qm("bob", "navigator", "check DNS")]),
    ).toEqual([
      { type: "text", text: "fix the test" },
      { type: "text", text: "[Suggestion from bob]: check DNS" },
    ]);
  });
});

describe("AgentBridge turns", () => {
  it("runs a prompt frame as an ACP turn and reports the natural stop reason", async () => {
    const { socket, agent } = harness();
    socket.emit({ type: "prompt", messages: [qm("alice", "driver", "go")] });
    expect(agent.prompts).toEqual([[{ type: "text", text: "go" }]]);
    await agent.endTurn("end_turn");
    expect(socket.turnEnds()).toEqual([{ type: "turn_ended", stopReason: "end_turn" }]);
  });

  it("hard-interrupt: a cancel frame cancels the turn and reports cancelled", async () => {
    const { socket, agent } = harness();
    socket.emit({ type: "prompt", messages: [qm("alice", "driver", "long task")] });
    socket.emit({ type: "cancel" });
    expect(agent.cancels).toBe(1);
    await agent.endTurn("cancelled");
    expect(socket.turnEnds()).toEqual([{ type: "turn_ended", stopReason: "cancelled" }]);
  });

  it("mid-turn injection: cancel-then-reprompt without ending the session turn", async () => {
    const { socket, agent } = harness();
    socket.emit({ type: "prompt", messages: [qm("alice", "driver", "start")] });
    socket.emit({ type: "prompt", messages: [qm("bob", "navigator", "try the cache")] });
    expect(agent.cancels).toBe(1);

    await agent.endTurn("cancelled");
    // The internal cancel is invisible: no turn_ended, and the queued
    // injection became the next ACP prompt continuing the same turn.
    expect(socket.turnEnds()).toEqual([]);
    expect(agent.prompts[1]).toEqual([
      { type: "text", text: "[Suggestion from bob]: try the cache" },
    ]);

    await agent.endTurn("end_turn");
    expect(socket.turnEnds()).toEqual([{ type: "turn_ended", stopReason: "end_turn" }]);
  });

  it("coalesces multiple injections arriving during one turn", async () => {
    const { socket, agent } = harness();
    socket.emit({ type: "prompt", messages: [qm("alice", "driver", "start")] });
    socket.emit({ type: "prompt", messages: [qm("alice", "driver", "also this")] });
    socket.emit({ type: "prompt", messages: [qm("bob", "navigator", "and this")] });

    await agent.endTurn("cancelled");
    expect(agent.prompts[1]).toEqual([
      { type: "text", text: "also this" },
      { type: "text", text: "[Suggestion from bob]: and this" },
    ]);
  });

  it("reports a cancelled turn when the agent cancels with nothing to inject", async () => {
    const { socket, agent } = harness();
    socket.emit({ type: "prompt", messages: [qm("alice", "driver", "task")] });
    await agent.endTurn("cancelled");
    expect(socket.turnEnds()).toEqual([{ type: "turn_ended", stopReason: "cancelled" }]);
  });

  it("surfaces malformed frames via onError and keeps working", async () => {
    const { socket, agent, errors } = harness();
    socket.emit({ type: "detonate" });
    expect(errors).toHaveLength(1);

    socket.emit({ type: "prompt", messages: [qm("alice", "driver", "task")] });
    await agent.endTurn("end_turn");
    expect(socket.turnEnds()).toEqual([{ type: "turn_ended", stopReason: "end_turn" }]);
  });
});

describe("AgentBridge permission gates", () => {
  const params = {
    sessionId: "acp-1",
    toolCall: { toolCallId: "tc-1", title: "Run rm -rf build" },
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" as const },
      { optionId: "deny", name: "Deny", kind: "reject_once" as const },
    ],
  };

  it("sends a permission_request frame and resolves when the decision returns", async () => {
    const { socket, bridge } = harness();
    const pending = bridge.requestPermission(params);

    const sent = socket.sent.find((f) => f.type === "permission_request");
    expect(sent).toMatchObject({
      type: "permission_request",
      toolCallId: "tc-1",
      title: "Run rm -rf build",
      options: params.options,
    });
    const requestId = (sent as { requestId: string }).requestId;

    // The session returns the Driver's decision in our wire shape (`kind`);
    // the bridge translates it back to ACP's shape (`outcome`) for the agent.
    socket.emit({
      type: "permission_decision",
      requestId,
      outcome: { kind: "selected", optionId: "allow" },
    });
    await expect(pending).resolves.toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("translates a cancelled decision to an ACP cancellation", async () => {
    const { socket, bridge } = harness();
    const pending = bridge.requestPermission(params);
    const requestId = (
      socket.sent.find((f) => f.type === "permission_request") as { requestId: string }
    ).requestId;
    socket.emit({ type: "permission_decision", requestId, outcome: { kind: "cancelled" } });
    await expect(pending).resolves.toEqual({ outcome: "cancelled" });
  });

  it("falls back to the toolCallId when the tool call has no title", async () => {
    const { socket, bridge } = harness();
    void bridge.requestPermission({ ...params, toolCall: { toolCallId: "tc-9" } });
    const sent = socket.sent.find((f) => f.type === "permission_request");
    expect(sent).toMatchObject({ title: "tc-9" });
  });
});

describe("AgentBridge with a real AcpClient and FakeAgent", () => {
  it("streams agent updates into agent_event frames end to end", async () => {
    const [clientSide, agentSide] = createTransportPair();
    new FakeAgent(agentSide);
    const socket = new FakeSocket();

    const bridgeRef: { current: AgentBridge | null } = { current: null };
    const client = new AcpClient(clientSide, {
      onSessionUpdate: (_sessionId, update) => bridgeRef.current?.onSessionUpdate(update),
      onPermissionRequest: () => Promise.resolve({ outcome: "cancelled" }),
    });
    await client.initialize();
    const acpSessionId = await client.newSession({ cwd: "/repo" });
    bridgeRef.current = new AgentBridge({ socket, agent: client, acpSessionId });

    socket.emit({ type: "prompt", messages: [qm("alice", "driver", "run the tests")] });
    await new Promise((r) => setTimeout(r, 10));

    const types = socket.sent.map((f) => (f.type === "agent_event" ? f.body.type : f.type));
    expect(types).toEqual(["agent_message_chunk", "tool_call", "tool_call_update", "turn_ended"]);
    expect(socket.turnEnds()).toEqual([{ type: "turn_ended", stopReason: "end_turn" }]);
  });
});
