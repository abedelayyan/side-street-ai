import { describe, expect, it } from "vitest";
import type { PermissionRequestParams } from "@side-street/acp-client";
import {
  agentSocketUrl,
  decidePermission,
  sessionSocketFromWebSocket,
  type WebSocketLike,
} from "../src/runner.js";

function permission(options: PermissionRequestParams["options"]): PermissionRequestParams {
  return { sessionId: "s", toolCall: { toolCallId: "t1" }, options };
}

describe("agentSocketUrl", () => {
  it("maps http session URLs to ws agent URLs", () => {
    expect(agentSocketUrl("http://localhost:8787/session/demo")).toBe(
      "ws://localhost:8787/session/demo/agent",
    );
  });

  it("maps https to wss and tolerates a trailing slash", () => {
    expect(agentSocketUrl("https://example.com/session/demo/")).toBe(
      "wss://example.com/session/demo/agent",
    );
  });
});

describe("decidePermission", () => {
  it("prefers allow_once over allow_always", () => {
    const outcome = decidePermission(
      permission([
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "once", name: "Once", kind: "allow_once" },
      ]),
    );
    expect(outcome).toEqual({ outcome: "selected", optionId: "once" });
  });

  it("falls back to allow_always", () => {
    const outcome = decidePermission(
      permission([
        { optionId: "no", name: "No", kind: "reject_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
      ]),
    );
    expect(outcome).toEqual({ outcome: "selected", optionId: "always" });
  });

  it("denies when no allow option exists", () => {
    const outcome = decidePermission(
      permission([{ optionId: "no", name: "No", kind: "reject_once" }]),
    );
    expect(outcome).toEqual({ outcome: "cancelled" });
  });
});

class FakeWebSocket implements WebSocketLike {
  readonly sent: string[] = [];
  private listener: ((event: { data: unknown }) => void) | undefined;
  send(data: string): void {
    this.sent.push(data);
  }
  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listener = listener;
  }
  receive(data: unknown): void {
    this.listener?.({ data });
  }
}

describe("sessionSocketFromWebSocket", () => {
  it("serializes outbound frames and parses inbound ones", () => {
    const ws = new FakeWebSocket();
    const socket = sessionSocketFromWebSocket(ws);
    const frames: unknown[] = [];
    socket.onFrame((frame) => frames.push(frame));

    socket.send({ type: "turn_ended", stopReason: "end_turn" });
    ws.receive('{"type":"cancel"}');

    expect(ws.sent).toEqual(['{"type":"turn_ended","stopReason":"end_turn"}']);
    expect(frames).toEqual([{ type: "cancel" }]);
  });

  it("passes malformed inbound data through for the bridge to reject", () => {
    const ws = new FakeWebSocket();
    const socket = sessionSocketFromWebSocket(ws);
    const frames: unknown[] = [];
    socket.onFrame((frame) => frames.push(frame));

    ws.receive("not json");

    expect(frames).toEqual(["not json"]);
  });
});
