/**
 * A minimal in-memory ACP agent for tests. It answers initialize and
 * session/new, and on session/prompt streams a scripted sequence of updates
 * (optionally requesting permission mid-turn) before ending the turn. A
 * session/cancel notification makes the in-flight prompt resolve with
 * stopReason "cancelled", matching the ACP contract.
 */

import type { Transport } from "./transport.js";

interface Frame {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class FakeAgent {
  /** Permission decisions received back from the client, for assertions. */
  readonly permissionOutcomes: unknown[] = [];
  private nextRequestId = 1000;
  private readonly pendingPermissions = new Map<string | number, (outcome: unknown) => void>();
  private activePrompt: { id: string | number; cancelled: boolean } | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly script: {
      /** Emit a permission request after this many streamed updates (off by default). */
      requestPermissionAfterChunks?: number;
    } = {},
  ) {
    transport.onMessage((raw) => {
      void this.handle(raw as Frame);
    });
  }

  private async handle(frame: Frame): Promise<void> {
    if (frame.method === undefined && frame.id !== undefined) {
      // Response to one of our own requests (a permission decision).
      const resolve = this.pendingPermissions.get(frame.id);
      if (resolve) {
        this.pendingPermissions.delete(frame.id);
        this.permissionOutcomes.push(frame.result);
        resolve(frame.result);
      }
      return;
    }

    switch (frame.method) {
      case "initialize":
        this.respond(frame.id, { protocolVersion: 1, agentCapabilities: {} });
        return;
      case "session/new":
        this.respond(frame.id, { sessionId: "sess-1" });
        return;
      case "session/prompt":
        await this.runTurn(frame.id as string | number, frame.params);
        return;
      case "session/cancel":
        if (this.activePrompt !== null) {
          this.activePrompt.cancelled = true;
        }
        return;
      default:
        if (frame.id !== undefined) {
          this.respond(frame.id, undefined, { code: -32601, message: "unknown method" });
        }
    }
  }

  private async runTurn(promptId: string | number, params: unknown): Promise<void> {
    const sessionId = (params as { sessionId: string }).sessionId;
    this.activePrompt = { id: promptId, cancelled: false };

    const updates = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Investigating" } },
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run tests", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
    ];

    let emitted = 0;
    for (const update of updates) {
      // Yield so cancel notifications delivered between updates take effect.
      await Promise.resolve();
      if (this.activePrompt.cancelled) {
        this.respond(promptId, { stopReason: "cancelled" });
        this.activePrompt = null;
        return;
      }
      this.notify("session/update", { sessionId, update });
      emitted++;
      if (this.script.requestPermissionAfterChunks === emitted) {
        await this.requestPermission(sessionId);
      }
    }

    await Promise.resolve();
    this.respond(promptId, { stopReason: this.activePrompt.cancelled ? "cancelled" : "end_turn" });
    this.activePrompt = null;
  }

  private requestPermission(sessionId: string): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pendingPermissions.set(id, resolve);
      this.transport.send({
        jsonrpc: "2.0",
        id,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "t1", title: "Run tests" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
    });
  }

  private respond(
    id: string | number | undefined,
    result: unknown,
    error?: { code: number; message: string },
  ): void {
    if (id === undefined) return;
    this.transport.send(
      error === undefined ? { jsonrpc: "2.0", id, result } : { jsonrpc: "2.0", id, error },
    );
  }

  private notify(method: string, params: unknown): void {
    this.transport.send({ jsonrpc: "2.0", method, params });
  }
}
