/**
 * The ACP client (ADR-0002): Side Street's side of the conversation with a
 * backing coding agent. The session actor uses this to prompt the agent,
 * stream its updates into the event log, hard-interrupt via cancel, and
 * surface permission requests to the Driver.
 */

import {
  PROTOCOL_VERSION,
  initializeResultSchema,
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  newSessionResultSchema,
  permissionRequestParamsSchema,
  promptResultSchema,
  sessionUpdateParamsSchema,
  type ContentBlock,
  type JsonRpcId,
  type PermissionOutcome,
  type PermissionRequestParams,
  type SessionUpdate,
  type StopReason,
} from "./protocol.js";
import type { Transport } from "./transport.js";

export interface AcpClientHandlers {
  onSessionUpdate(sessionId: string, update: SessionUpdate): void;
  /** Surfaced to the Driver; resolves with the human's decision. */
  onPermissionRequest(params: PermissionRequestParams): Promise<PermissionOutcome>;
  /** Malformed frames and handler failures land here instead of being silently dropped. */
  onError?(error: Error): void;
}

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  constructor(
    private readonly transport: Transport,
    private readonly handlers: AcpClientHandlers,
  ) {
    transport.onMessage((message) => {
      this.dispatch(message);
    });
  }

  async initialize(): Promise<void> {
    const raw = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    initializeResultSchema.parse(raw);
  }

  async newSession(params: { cwd: string }): Promise<string> {
    const raw = await this.request("session/new", { cwd: params.cwd, mcpServers: [] });
    return newSessionResultSchema.parse(raw).sessionId;
  }

  /** Resolves when the agent's turn ends — including with `cancelled` after a cancel(). */
  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<StopReason> {
    const raw = await this.request("session/prompt", { sessionId, prompt });
    return promptResultSchema.parse(raw).stopReason;
  }

  /** Fire-and-forget hard-interrupt; the in-flight prompt() resolves with "cancelled". */
  cancel(sessionId: string): void {
    this.transport.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  close(): void {
    const error = new Error("ACP client closed");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.transport.close();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private dispatch(message: unknown): void {
    const response = jsonRpcResponseSchema.safeParse(message);
    if (response.success && !("method" in (message as object))) {
      this.dispatchResponse(response.data);
      return;
    }
    const request = jsonRpcRequestSchema.safeParse(message);
    if (request.success) {
      void this.dispatchAgentRequest(request.data.id, request.data.method, request.data.params);
      return;
    }
    const notification = jsonRpcNotificationSchema.safeParse(message);
    if (notification.success) {
      this.dispatchNotification(notification.data.method, notification.data.params);
      return;
    }
    this.handlers.onError?.(new Error(`unparseable ACP frame: ${JSON.stringify(message)}`));
  }

  private dispatchResponse(response: {
    id: JsonRpcId;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown } | undefined;
  }): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.handlers.onError?.(new Error(`response for unknown request id ${response.id}`));
      return;
    }
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(`agent error ${response.error.code}: ${response.error.message}`));
    } else {
      pending.resolve(response.result);
    }
  }

  private dispatchNotification(method: string, params: unknown): void {
    if (method !== "session/update") {
      return; // Tolerate notifications we don't model yet.
    }
    const parsed = sessionUpdateParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.handlers.onError?.(new Error(`malformed session/update: ${parsed.error.message}`));
      return;
    }
    this.handlers.onSessionUpdate(parsed.data.sessionId, parsed.data.update);
  }

  private async dispatchAgentRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method !== "session/request_permission") {
      this.transport.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not supported: ${method}` },
      });
      return;
    }
    const parsed = permissionRequestParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.transport.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "malformed permission request" },
      });
      return;
    }
    try {
      const outcome = await this.handlers.onPermissionRequest(parsed.data);
      this.transport.send({ jsonrpc: "2.0", id, result: { outcome } });
    } catch (error) {
      // A failed Driver decision must deny, never allow, the tool call.
      this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.transport.send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
    }
  }
}
