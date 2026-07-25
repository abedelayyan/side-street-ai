import { describe, expect, it } from "vitest";
import { AcpClient } from "../src/client.js";
import type { PermissionOutcome, SessionUpdate } from "../src/protocol.js";
import { createTransportPair } from "../src/transport.js";
import { FakeAgent } from "./fake-agent.js";

interface Recorded {
  updates: SessionUpdate[];
  errors: Error[];
}

function setup(options?: {
  requestPermissionAfterChunks?: number;
  decide?: () => Promise<PermissionOutcome>;
}): { client: AcpClient; agent: FakeAgent; recorded: Recorded } {
  const [clientSide, agentSide] = createTransportPair();
  const recorded: Recorded = { updates: [], errors: [] };
  const agent = new FakeAgent(agentSide, {
    ...(options?.requestPermissionAfterChunks === undefined
      ? {}
      : { requestPermissionAfterChunks: options.requestPermissionAfterChunks }),
  });
  const client = new AcpClient(clientSide, {
    onSessionUpdate: (_sessionId, update) => recorded.updates.push(update),
    onPermissionRequest: options?.decide ?? (() => Promise.reject(new Error("unexpected"))),
    onError: (error) => recorded.errors.push(error),
  });
  return { client, agent, recorded };
}

describe("AcpClient", () => {
  it("initializes, opens a session, and streams a full turn", async () => {
    const { client, recorded } = setup();
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "/repo" });
    expect(sessionId).toBe("sess-1");

    const stopReason = await client.prompt(sessionId, [{ type: "text", text: "fix the bug" }]);
    expect(stopReason).toBe("end_turn");
    expect(recorded.updates.map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
    ]);
    expect(recorded.errors).toEqual([]);
  });

  it("cancel() resolves the in-flight prompt with stopReason cancelled", async () => {
    const { client, recorded } = setup();
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "/repo" });

    const turn = client.prompt(sessionId, [{ type: "text", text: "long task" }]);
    client.cancel(sessionId);
    expect(await turn).toBe("cancelled");
    // The turn stopped early: not all scripted updates arrived.
    expect(recorded.updates.length).toBeLessThan(3);
  });

  it("routes permission requests to the handler and returns the decision", async () => {
    const { client, agent } = setup({
      requestPermissionAfterChunks: 2,
      decide: () => Promise.resolve({ outcome: "selected", optionId: "allow" }),
    });
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "/repo" });
    await client.prompt(sessionId, [{ type: "text", text: "run the tests" }]);
    expect(agent.permissionOutcomes).toEqual([
      { outcome: { outcome: "selected", optionId: "allow" } },
    ]);
  });

  it("denies (cancelled), never allows, when the permission handler fails", async () => {
    const { client, agent, recorded } = setup({
      requestPermissionAfterChunks: 1,
      decide: () => Promise.reject(new Error("driver disconnected")),
    });
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "/repo" });
    await client.prompt(sessionId, [{ type: "text", text: "run the tests" }]);
    expect(agent.permissionOutcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(recorded.errors.map((e) => e.message)).toContain("driver disconnected");
  });

  it("surfaces malformed frames via onError without crashing the session", async () => {
    const [clientSide, agentSide] = createTransportPair();
    const errors: Error[] = [];
    new AcpClient(clientSide, {
      onSessionUpdate: () => undefined,
      onPermissionRequest: () => Promise.resolve({ outcome: "cancelled" }),
      onError: (error) => errors.push(error),
    });
    agentSide.send({ not: "jsonrpc" });
    agentSide.send({ jsonrpc: "2.0", method: "session/update", params: { bad: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(2);
  });

  it("rejects pending requests when closed", async () => {
    const { client } = setup();
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "/repo" });
    const turn = client.prompt(sessionId, [{ type: "text", text: "task" }]);
    client.close();
    await expect(turn).rejects.toThrow("ACP client closed");
  });
});
