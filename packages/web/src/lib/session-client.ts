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
 *
 * A connection the client did not close itself is always retried: a laptop
 * closing its lid, a proxy timing out an idle socket, or a Worker restart
 * must not end the session in the viewer's tab.
 */

import {
  serverFrameSchema,
  type PermissionOutcome,
  type Role,
  type ServerFrame,
  type SignedEvent,
} from "@side-street/core";
import { z } from "zod";

const replaySchema = z.object({ events: z.array(z.unknown()) });

/**
 * Backoff ladder between reconnect attempts, in ms; the last step repeats.
 * The first step is short enough that a blip is invisible, the last long
 * enough that a real outage doesn't hammer the Worker.
 * ponytail: no jitter — a session is a handful of viewers, not a herd. Add it
 * if reconnect storms ever show up in Worker logs.
 */
const RECONNECT_DELAYS_MS = [250, 1000, 3000, 10_000];

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
  /** True between `connect()` and `close()`: a drop in this window is retried. */
  private wanted = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: SessionClientOptions) {}

  get lastSeq(): number {
    return this.cursor;
  }

  connect(): void {
    this.wanted = true;
    this.clearRetry();
    if (this.socket !== undefined) {
      return;
    }
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
        this.scheduleRetry();
      }
    });
  }

  /**
   * Reconnect now rather than waiting out the backoff. The browser knows
   * things the ladder doesn't — the tab came back to the foreground, the
   * network came back — so the UI layer calls this on those events.
   */
  resume(): void {
    if (!this.wanted || this.socket !== undefined) {
      return;
    }
    this.attempt = 0;
    this.connect();
  }

  /** Leave for good: no retry follows. */
  close(): void {
    this.wanted = false;
    this.clearRetry();
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

  /** Answer a pending permission request (the server enforces Driver-only). */
  decide(requestId: string, outcome: PermissionOutcome): void {
    this.send({ type: "decide", requestId, outcome });
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
        // A welcome proves the connection works: start the ladder over so the
        // next drop retries immediately rather than at the last delay.
        this.attempt = 0;
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
      // No cursor means no history: take the compacted replay (newest
      // checkpoint + tail) rather than every event ever. A reconnect has a
      // cursor and takes the exact delta.
      const from = this.cursor < 0 ? "checkpoint" : String(this.cursor + 1);
      const url = `${this.options.baseUrl}/session/${this.options.sessionId}/events?from=${from}`;
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

  private scheduleRetry(): void {
    if (!this.wanted || this.retryTimer !== undefined) {
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private setStatus(status: SessionStatus): void {
    this.options.onStatus?.(status);
  }
}
