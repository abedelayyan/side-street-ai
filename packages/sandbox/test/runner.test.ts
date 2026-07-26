import { describe, expect, it } from "vitest";
import { agentSocketUrl, sessionSocketFromWebSocket, type WebSocketLike } from "../src/runner.js";

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
