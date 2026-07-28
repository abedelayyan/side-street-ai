/**
 * The per-session Durable Object (ADR-0001): binds the runtime-agnostic
 * SessionActor to durable SQLite, hibernating WebSockets, and the sandbox
 * agent bridge. Per-message work stays minimal — append, persist snapshot,
 * broadcast — everything heavy lives on the other side of the agent socket.
 */

import { DurableObject } from "cloudflare:workers";
import {
  agentFrameSchema,
  joinParamsSchema,
  signedEventSchema,
  verifyChain,
  viewerFrameSchema,
  type AgentServerFrame,
  type Role,
  type ServerFrame,
  type SignedEvent,
} from "@side-street/core";
import { redactEventForRole, type RedactionConfig } from "@side-street/redaction";
import {
  SessionActor,
  type AgentPort,
  type Broadcaster,
  type EventStore,
  type PrivateMessage,
  type SessionActorSnapshot,
} from "@side-street/session";

export interface Env {
  SESSIONS: DurableObjectNamespace<SessionDurableObject>;
}

type Attachment = { kind: "viewer"; participantId: string; role: Role } | { kind: "agent" };

const SNAPSHOT_KEY = "actor-snapshot";
const OUTBOX_KEY = "agent-outbox";
const SECRETS_KEY = "known-secrets";

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
  /**
   * Redaction applied to every outbound event, per recipient role. Default
   * policy redacts secrets for all roles (the Observer floor, applied to
   * everyone). `knownSecrets` holds the credentials the sandbox declared on
   * connect — see `registerSecrets`.
   */
  private redactionConfig: RedactionConfig = {};

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.store = new SqliteEventStore(ctx.storage.sql);
      const snapshot = await ctx.storage.get<SessionActorSnapshot>(SNAPSHOT_KEY);
      this.outbox = (await ctx.storage.get<AgentServerFrame[]>(OUTBOX_KEY)) ?? [];
      const knownSecrets = await ctx.storage.get<string[]>(SECRETS_KEY);
      if (knownSecrets !== undefined) {
        this.redactionConfig = { knownSecrets };
      }
      const broadcaster: Broadcaster = {
        broadcast: (event) => this.broadcastEvent(event),
        sendTo: (participantId, message) => this.sendPrivate(participantId, message),
      };
      const agent: AgentPort = {
        prompt: (messages) => this.toAgent({ type: "prompt", messages: [...messages] }),
        cancel: () => this.toAgent({ type: "cancel" }),
        respondPermission: (requestId, outcome) =>
          this.toAgent({ type: "permission_decision", requestId, outcome }),
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
      // The viewer fetches replay cross-origin (the UI is served elsewhere);
      // WebSockets are exempt from CORS but this endpoint is not. Wide open
      // matches v0's unauthenticated access model — revisit with Phase 2 auth.
      const cors = { "Access-Control-Allow-Origin": "*" };
      const from = url.searchParams.get("from") ?? "0";
      let history: SignedEvent[];
      if (from === "checkpoint") {
        // A viewer with no history takes the compacted replay: the newest
        // checkpoint (which carries the state before it) plus the tail.
        history = await this.actor.replayFromCheckpoint();
      } else {
        const fromSeq = Number(from);
        if (!Number.isInteger(fromSeq) || fromSeq < 0) {
          return Response.json({ error: "invalid 'from' offset" }, { status: 400, headers: cors });
        }
        history = await this.actor.replayFrom(fromSeq);
      }
      // Replay is an outbound path too, so it gets the same redaction pass as
      // the broadcast path. The endpoint carries no authenticated identity, so
      // it gets the Observer floor — the strictest view — whoever asks. A
      // per-role replay view needs the Phase 2 authentication deliverable
      // first; asking politely in a query param is not identity.
      const events = history.map((event) =>
        redactEventForRole(event, "observer", this.redactionConfig),
      );
      return Response.json({ events }, { headers: cors });
    }
    if (url.pathname.endsWith("/verify")) {
      // Tamper-evidence surface: re-verifies the full chain server-side so
      // any client (or auditor) can check the log without downloading it.
      const result = await verifyChain(await this.actor.replayFrom(0));
      return Response.json(result, { headers: { "Access-Control-Allow-Origin": "*" } });
    }
    if (url.pathname.endsWith("/ws")) {
      return this.acceptViewer(request, url);
    }
    if (url.pathname.endsWith("/agent")) {
      await this.ensureStarted();
      return await this.acceptAgent(request);
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
    server.serializeAttachment({ kind: "viewer", participantId, role } satisfies Attachment);

    await this.ensureStarted();
    // Welcome must be the socket's first frame (docs/protocol.md): join()
    // broadcasts the join event to every viewer including this one, and an
    // event arriving before welcome advances the client's cursor past the
    // history it never fetched, silently skipping replay.
    this.send(server, {
      type: "welcome",
      participantId,
      role,
      lastSeq: this.store.lastSeq(),
    });
    await this.actor.join({ id: participantId, displayName, role });
    await this.persistState();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptAgent(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ error: "expected websocket upgrade" }, { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ kind: "agent" } satisfies Attachment);
    // A decision or a cancel refers to a tool call or turn that belonged to
    // the agent process that just died; delivering it to a fresh one would
    // answer a question nobody asked. Undelivered prompts are human steering
    // and still stand.
    this.outbox = this.outbox.filter((frame) => frame.type === "prompt");
    await this.actor.onAgentAttached();
    await this.persistState();
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
      if (frame.data.type === "register_secrets") {
        // Deliberately not an event and not a broadcast: secrets stay out of
        // the log entirely (PLAN.md invariant 4).
        await this.registerSecrets(frame.data.values);
        return;
      }
      if (frame.data.type === "agent_event") {
        await this.actor.onAgentEvent(frame.data.body);
      } else if (frame.data.type === "turn_ended") {
        await this.actor.onTurnEnded(frame.data.stopReason);
      } else {
        await this.actor.onPermissionRequest({
          requestId: frame.data.requestId,
          toolCallId: frame.data.toolCallId,
          title: frame.data.title,
          options: frame.data.options,
        });
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
    } else if (frame.data.type === "handoff") {
      await this.actor.handoff(attachment.participantId, frame.data.toParticipantId);
    } else {
      await this.actor.decide(attachment.participantId, frame.data.requestId, frame.data.outcome);
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

  /**
   * Record the credentials the sandbox was booted with, so the redaction pass
   * can strip them by exact value. They are stored durably — hibernation must
   * not lose them, because the leak is an unredacted broadcast — but never
   * appended to the log and never sent to a viewer. They outlive the grant on
   * purpose: a credential the agent echoes after expiry is still a secret in
   * front of everyone watching.
   */
  private async registerSecrets(values: readonly string[]): Promise<void> {
    const known = new Set(this.redactionConfig.knownSecrets ?? []);
    const before = known.size;
    for (const value of values) {
      known.add(value);
    }
    if (known.size === before) {
      return;
    }
    const knownSecrets = [...known];
    this.redactionConfig = { ...this.redactionConfig, knownSecrets };
    await this.ctx.storage.put(SECRETS_KEY, knownSecrets);
  }

  /**
   * Fan out an event, redacted per the recipient's role BEFORE it leaves the
   * DO (PLAN.md invariant 5). Redaction is memoized per role — at most three
   * distinct payloads regardless of viewer count.
   */
  private broadcastEvent(event: SignedEvent): void {
    const payloadByRole = new Map<Role, string>();
    for (const ws of this.viewerSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment;
      if (attachment.kind !== "viewer") {
        continue;
      }
      let payload = payloadByRole.get(attachment.role);
      if (payload === undefined) {
        const redacted = redactEventForRole(event, attachment.role, this.redactionConfig);
        payload = JSON.stringify({ type: "event", event: redacted } satisfies ServerFrame);
        payloadByRole.set(attachment.role, payload);
      }
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
