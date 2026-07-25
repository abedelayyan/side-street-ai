/**
 * Session client: connects the viewer socket, performs offset replay, and
 * delivers a single ordered, deduplicated event stream (docs/protocol.md,
 * "Replay"). Framework-agnostic — the socket and fetch are injectable so
 * the protocol logic is testable without a browser or a server.
 *
 * Late-join / reconnect sequence: connect → `welcome` → fetch the tail from
 * the local cursor → apply tail, then any live frames buffered during the
 * fetch — deduplicating by `seq` throughout. The cursor survives reconnects,
 * so a dropped connection resumes with only the missed delta.
 */

import {
  serverFrameSchema,
  type Role,
  type ServerFrame,
  type SignedEvent,
} from "@side-street/core";
import { z } from "zod";

const replaySchema = z.object({ events: z.array(z.unknown()) });

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close", listener: (event: never) => void): void;
}

export type SessionStatus = "connecting" | "replaying" | "live" | "closed";

export interface SessionClientOptions {
  /** Worker origin, e.g. http://localhost:8787 */
  baseUrl: string;
  sessionId: string;
  participantId: string;
  displayName: string;
  role: Role;
  onEvent(event: SignedEvent): void;
  onStatus?(status: SessionStatus): void;
  onRejection?(messageId: string, reason: string): void;
  onError?(error: Error): void;
  /** Injectable for tests; defaults to the browser WebSocket. */
  createSocket?(url: string): WebSocketLike;
  fetchFn?(url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

export class SessionClient {
  private socket: WebSocketLike | undefined;
  /** Highest seq already delivered to onEvent. */
  private cursor = -1;
  private replaying = false;
  private buffered: SignedEvent[] = [];
  private nextMessageId = 0;

  constructor(private readonly options: SessionClientOptions) {}

  get lastSeq(): number {
    return this.cursor;
  }

  connect(): void {
    const { baseUrl, sessionId, participantId, displayName, role } = this.options;
    const wsBase = baseUrl.replace(/^http/, "ws");
    const params = new URLSearchParams({ participantId, displayName, role });
    const url = `${wsBase}/session/${sessionId}/ws?${params.toString()}`;
    const createSocket =
      this.options.createSocket ?? ((u: string) => new WebSocket(u) as WebSocketLike);
    this.setStatus("connecting");
    const socket = createSocket(url);
    this.socket = socket;
    socket.addEventListener("message", (event: { data: unknown }) => {
      this.handleRaw(String(event.data));
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.setStatus("closed");
      }
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.setStatus("closed");
  }

  /** Send a steering message; returns the frame id for rejection matching. */
  steer(text: string, delivery: "queue" | "interrupt"): string {
    const id = `${this.options.participantId}-${++this.nextMessageId}`;
    this.send({ type: "steer", id, text, delivery });
    return id;
  }

  takeWheel(toParticipantId = this.options.participantId): void {
    this.send({ type: "handoff", toParticipantId });
  }

  private send(frame: unknown): void {
    if (this.socket === undefined) {
      this.options.onError?.(new Error("not connected"));
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }

  private handleRaw(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = serverFrameSchema.parse(JSON.parse(raw));
    } catch {
      this.options.onError?.(new Error("malformed server frame"));
      return;
    }
    switch (frame.type) {
      case "welcome":
        void this.replay(frame.lastSeq);
        return;
      case "event":
        if (this.replaying) {
          this.buffered.push(frame.event);
        } else {
          this.deliver(frame.event);
        }
        return;
      case "steer_rejected":
        this.options.onRejection?.(frame.messageId, frame.reason);
        return;
      case "error":
        this.options.onError?.(new Error(frame.message));
        return;
    }
  }

  private async replay(serverLastSeq: number): Promise<void> {
    if (serverLastSeq <= this.cursor) {
      this.setStatus("live");
      return;
    }
    this.replaying = true;
    this.setStatus("replaying");
    try {
      const fetchFn = this.options.fetchFn ?? ((url: string) => fetch(url));
      const url = `${this.options.baseUrl}/session/${this.options.sessionId}/events?from=${this.cursor + 1}`;
      const response = await fetchFn(url);
      if (!response.ok) {
        throw new Error("replay request failed");
      }
      const parsed = replaySchema.parse(await response.json());
      for (const event of parsed.events as SignedEvent[]) {
        this.deliver(event);
      }
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.replaying = false;
      const buffered = this.buffered;
      this.buffered = [];
      for (const event of buffered) {
        this.deliver(event);
      }
      this.setStatus("live");
    }
  }

  private deliver(event: SignedEvent): void {
    if (event.seq <= this.cursor) {
      return;
    }
    this.cursor = event.seq;
    this.options.onEvent(event);
  }

  private setStatus(status: SessionStatus): void {
    this.options.onStatus?.(status);
  }
}
