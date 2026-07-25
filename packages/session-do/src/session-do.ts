/**
 * The per-session Durable Object (ADR-0001): binds the runtime-agnostic
 * SessionActor to durable SQLite, hibernating WebSockets, and the sandbox
 * agent bridge. Per-message work stays minimal — append, persist snapshot,
 * broadcast — everything heavy lives on the other side of the agent socket.
 */

import { DurableObject } from "cloudflare:workers";
import { signedEventSchema, type SignedEvent } from "@side-street/core";
import {
  SessionActor,
  type AgentPort,
  type Broadcaster,
  type EventStore,
  type PrivateMessage,
  type SessionActorSnapshot,
} from "@side-street/session";
import {
  agentFrameSchema,
  joinParamsSchema,
  viewerFrameSchema,
  type AgentServerFrame,
  type ServerFrame,
} from "./messages.js";

export interface Env {
  SESSIONS: DurableObjectNamespace<SessionDurableObject>;
}

type Attachment = { kind: "viewer"; participantId: string } | { kind: "agent" };

const SNAPSHOT_KEY = "actor-snapshot";
const OUTBOX_KEY = "agent-outbox";

class SqliteEventStore implements EventStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        v INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        author_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      )`,
    );
  }

  last(): Promise<SignedEvent | undefined> {
    const rows = this.sql.exec("SELECT * FROM events ORDER BY seq DESC LIMIT 1").toArray();
    return Promise.resolve(rows[0] === undefined ? undefined : rowToEvent(rows[0]));
  }

  append(event: SignedEvent): Promise<void> {
    this.sql.exec(
      "INSERT INTO events (seq, v, ts, author_id, type, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      event.seq,
      event.v,
      event.ts,
      event.authorId,
      event.body.type,
      JSON.stringify(event.body.payload),
      event.prevHash,
      event.hash,
    );
    return Promise.resolve();
  }

  from(fromSeq: number): Promise<SignedEvent[]> {
    const rows = this.sql.exec("SELECT * FROM events WHERE seq >= ? ORDER BY seq", fromSeq);
    return Promise.resolve(rows.toArray().map(rowToEvent));
  }

  lastSeq(): number {
    const rows = this.sql.exec("SELECT MAX(seq) AS max_seq FROM events").toArray();
    const max = rows[0]?.["max_seq"];
    return typeof max === "number" ? max : -1;
  }
}

function rowToEvent(row: Record<string, SqlStorageValue>): SignedEvent {
  return signedEventSchema.parse({
    v: row["v"],
    seq: row["seq"],
    ts: row["ts"],
    authorId: row["author_id"],
    body: { type: row["type"], payload: JSON.parse(String(row["payload"])) },
    prevHash: row["prev_hash"],
    hash: row["hash"],
  });
}

export class SessionDurableObject extends DurableObject<Env> {
  private actor!: SessionActor;
  private store!: SqliteEventStore;
  /** Prompt/cancel frames waiting for the agent bridge to (re)connect. */
  private outbox: AgentServerFrame[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.store = new SqliteEventStore(ctx.storage.sql);
      const snapshot = await ctx.storage.get<SessionActorSnapshot>(SNAPSHOT_KEY);
      this.outbox = (await ctx.storage.get<AgentServerFrame[]>(OUTBOX_KEY)) ?? [];
      const broadcaster: Broadcaster = {
        broadcast: (event) => this.broadcastToViewers({ type: "event", event }),
        sendTo: (participantId, message) => this.sendPrivate(participantId, message),
      };
      const agent: AgentPort = {
        prompt: (messages) => this.toAgent({ type: "prompt", messages: [...messages] }),
        cancel: () => this.toAgent({ type: "cancel" }),
      };
      this.actor = new SessionActor(
        { store: this.store, broadcaster, agent, now: () => Date.now() },
        snapshot,
      );
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/events")) {
      const fromSeq = Number(url.searchParams.get("from") ?? "0");
      if (!Number.isInteger(fromSeq) || fromSeq < 0) {
        return Response.json({ error: "invalid 'from' offset" }, { status: 400 });
      }
      return Response.json({ events: await this.actor.replayFrom(fromSeq) });
    }
    if (url.pathname.endsWith("/ws")) {
      return this.acceptViewer(request, url);
    }
    if (url.pathname.endsWith("/agent")) {
      return this.acceptAgent(request);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  private async acceptViewer(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ error: "expected websocket upgrade" }, { status: 426 });
    }
    const params = joinParamsSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!params.success) {
      return Response.json({ error: "invalid join parameters" }, { status: 400 });
    }
    const { participantId, displayName, role } = params.data;

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ kind: "viewer", participantId } satisfies Attachment);

    await this.ensureStarted();
    await this.actor.join({ id: participantId, displayName, role });
    await this.persistState();
    this.send(server, {
      type: "welcome",
      participantId,
      role,
      lastSeq: this.store.lastSeq(),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptAgent(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ error: "expected websocket upgrade" }, { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ kind: "agent" } satisfies Attachment);
    this.flushOutbox(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      this.send(ws, { type: "error", message: "frame is not valid JSON" });
      return;
    }

    if (attachment.kind === "agent") {
      const frame = agentFrameSchema.safeParse(parsedJson);
      if (!frame.success) {
        this.send(ws, { type: "error", message: "invalid agent frame" });
        return;
      }
      if (frame.data.type === "agent_event") {
        await this.actor.onAgentEvent(frame.data.body);
      } else {
        await this.actor.onTurnEnded(frame.data.stopReason);
      }
      await this.persistState();
      return;
    }

    const frame = viewerFrameSchema.safeParse(parsedJson);
    if (!frame.success) {
      this.send(ws, { type: "error", message: "invalid frame" });
      return;
    }
    if (frame.data.type === "steer") {
      await this.actor.steer(attachment.participantId, {
        id: frame.data.id,
        text: frame.data.text,
        delivery: frame.data.delivery,
      });
    } else {
      await this.actor.handoff(attachment.participantId, frame.data.toParticipantId);
    }
    await this.persistState();
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment;
    if (attachment.kind === "viewer") {
      // Only mark departure when no other socket remains for this participant
      // (multi-tab and reconnects race the close of the old socket).
      const remaining = this.viewerSockets().filter(
        (other) =>
          other !== ws &&
          (other.deserializeAttachment() as Attachment & { participantId?: string })
            .participantId === attachment.participantId,
      );
      if (remaining.length === 0) {
        await this.actor.leave(attachment.participantId);
        await this.persistState();
      }
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.store.lastSeq() >= 0) {
      return;
    }
    await this.actor.start(this.ctx.id.toString(), "claude-code", "e2b");
  }

  private viewerSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => (ws.deserializeAttachment() as Attachment).kind === "viewer");
  }

  private agentSocket(): WebSocket | undefined {
    return this.ctx
      .getWebSockets()
      .find((ws) => (ws.deserializeAttachment() as Attachment).kind === "agent");
  }

  private broadcastToViewers(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const ws of this.viewerSockets()) {
      ws.send(payload);
    }
  }

  private sendPrivate(participantId: string, message: PrivateMessage): void {
    const frame: ServerFrame = {
      type: "steer_rejected",
      messageId: message.messageId,
      reason: message.reason,
    };
    for (const ws of this.viewerSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment;
      if (attachment.kind === "viewer" && attachment.participantId === participantId) {
        ws.send(JSON.stringify(frame));
      }
    }
  }

  private toAgent(frame: AgentServerFrame): void {
    const agent = this.agentSocket();
    if (agent === undefined) {
      this.outbox.push(frame);
      return;
    }
    agent.send(JSON.stringify(frame));
  }

  private flushOutbox(agent: WebSocket): void {
    for (const frame of this.outbox) {
      agent.send(JSON.stringify(frame));
    }
    this.outbox = [];
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    ws.send(JSON.stringify(frame));
  }

  private async persistState(): Promise<void> {
    await this.ctx.storage.put(SNAPSHOT_KEY, this.actor.snapshot);
    await this.ctx.storage.put(OUTBOX_KEY, this.outbox);
  }
}
