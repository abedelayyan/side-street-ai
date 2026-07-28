/**
 * The session actor (PLAN.md §3): single writer of the append-only event
 * log, owner of the roster and steering state, fan-out point for viewers.
 * One instance exists per session (the Durable Object guarantees this in
 * production); all methods assume single-threaded execution.
 */

import {
  SteeringController,
  appendEvent,
  stepIdFor,
  type EventBody,
  type IdempotencyKey,
  type PermissionOption,
  type PermissionOutcome,
  type PermissionRequestPayload,
  type Role,
  type SignedEvent,
  type SteeringEffect,
  type SteeringState,
} from "@side-street/core";
import type { AgentPort, Broadcaster, EventStore } from "./ports.js";

/**
 * Events between checkpoints. Bounds what a late joiner has to load without
 * making checkpoints a visible share of the log.
 * ponytail: a fixed event count, not elapsed time or byte size. If sessions
 * appear where 100 events is a second for one and a day for another, key it
 * off the interval that actually hurts.
 */
export const CHECKPOINT_EVERY = 100;

export interface RosterEntry {
  id: string;
  displayName: string;
  role: Role;
}

export interface SessionActorDeps {
  store: EventStore;
  broadcaster: Broadcaster;
  agent: AgentPort;
  now(): number;
}

export interface SessionActorSnapshot {
  steering: SteeringState;
  roster: RosterEntry[];
  /** Permission requests awaiting a Driver decision — survives hibernation. */
  pendingPermissions: PermissionRequestPayload[];
  /** Seq of the newest checkpoint event, or -1 if none has been written yet. */
  lastCheckpointSeq: number;
  /** Approvals granted per `stepId`, i.e. the last attempt number issued. */
  stepAttempts: Record<string, number>;
  /** Session id, for the idempotency keys minted on approval. */
  sessionId: string;
}

export interface PermissionRequest {
  requestId: string;
  toolCallId: string;
  title: string;
  options: PermissionOption[];
}

export type SteerInput = { id: string; text: string; delivery: "queue" | "interrupt" };

export class SessionActor {
  private readonly steering: SteeringController;
  private readonly roster = new Map<string, RosterEntry>();
  private readonly pendingPermissions: Map<string, PermissionRequestPayload>;
  private lastCheckpointSeq: number;
  private readonly stepAttempts: Record<string, number>;
  private sessionId: string;

  constructor(
    private readonly deps: SessionActorDeps,
    snapshot?: SessionActorSnapshot,
  ) {
    this.steering = new SteeringController(snapshot?.steering);
    for (const entry of snapshot?.roster ?? []) {
      this.roster.set(entry.id, entry);
    }
    this.pendingPermissions = new Map(
      (snapshot?.pendingPermissions ?? []).map((request) => [request.requestId, request]),
    );
    this.lastCheckpointSeq = snapshot?.lastCheckpointSeq ?? -1;
    this.stepAttempts = { ...snapshot?.stepAttempts };
    this.sessionId = snapshot?.sessionId ?? "";
  }

  /** Serializable state for the wrapper to persist alongside the event log. */
  get snapshot(): SessionActorSnapshot {
    return {
      steering: this.steering.state,
      roster: [...this.roster.values()],
      pendingPermissions: [...this.pendingPermissions.values()],
      lastCheckpointSeq: this.lastCheckpointSeq,
      stepAttempts: { ...this.stepAttempts },
      sessionId: this.sessionId,
    };
  }

  get driverId(): string | null {
    return this.steering.state.driverId;
  }

  async start(sessionId: string, agent: string, sandboxProvider: string): Promise<void> {
    this.sessionId = sessionId;
    await this.append("system", {
      type: "session_started",
      payload: { sessionId, agent, sandboxProvider },
    });
  }

  /** Idempotent: a reconnect by an existing participant logs nothing. */
  async join(entry: RosterEntry): Promise<void> {
    if (this.roster.has(entry.id)) {
      return;
    }
    this.roster.set(entry.id, entry);
    await this.append(entry.id, {
      type: "participant_joined",
      payload: { participantId: entry.id, displayName: entry.displayName, role: entry.role },
    });
  }

  async leave(participantId: string): Promise<void> {
    if (!this.roster.delete(participantId)) {
      return;
    }
    this.steering.releaseWheel(participantId);
    await this.append(participantId, {
      type: "participant_left",
      payload: { participantId },
    });
  }

  /**
   * A participant submits a steering message. Accepted messages are logged
   * with attribution and may trigger agent effects; rejections go back to
   * the sender alone and never touch the log.
   */
  async steer(participantId: string, input: SteerInput): Promise<void> {
    const participant = this.roster.get(participantId);
    if (!participant) {
      this.deps.broadcaster.sendTo(participantId, {
        kind: "steer_rejected",
        messageId: input.id,
        reason: "not a session participant",
      });
      return;
    }
    const result = this.steering.submit(
      { id: participant.id, role: participant.role },
      input,
      this.deps.now(),
    );
    if (!result.accepted) {
      this.deps.broadcaster.sendTo(participantId, {
        kind: "steer_rejected",
        messageId: input.id,
        reason: result.reason,
      });
      return;
    }
    await this.append(participantId, {
      type: "human_message",
      payload: { text: input.text, delivery: input.delivery },
    });
    this.applyEffects(result.effects);
  }

  /** "Take the wheel": claim a free wheel or receive it from the current Driver. */
  async handoff(requestedById: string, toParticipantId: string): Promise<void> {
    const requester = this.roster.get(requestedById);
    const target = this.roster.get(toParticipantId);
    if (!requester || !target) {
      return;
    }
    const previousDriver = this.steering.state.driverId;
    const result = this.steering.handoff(
      { id: requester.id, role: requester.role },
      toParticipantId,
    );
    if (!result.ok) {
      return;
    }
    await this.append(requestedById, {
      type: "control_handoff",
      payload: { fromParticipantId: previousDriver ?? requestedById, toParticipantId },
    });
  }

  /** An update streamed from the agent (already translated to an event body). */
  async onAgentEvent(body: EventBody): Promise<void> {
    await this.append("agent", body);
    const boundaryReached =
      body.type === "tool_call_update" &&
      (body.payload.status === "completed" || body.payload.status === "failed");
    if (boundaryReached) {
      this.applyEffects(this.steering.onToolCallBoundary());
    }
  }

  /**
   * The agent asked to run a side-effecting tool. Log the request and hold it
   * pending; nothing runs until the Driver decides (PLAN.md: approval gates are
   * the load-bearing control against prompt injection).
   */
  async onPermissionRequest(request: PermissionRequest): Promise<void> {
    const stepId = await stepIdFor(request.title);
    const payload: PermissionRequestPayload = {
      requestId: request.requestId,
      toolCallId: request.toolCallId,
      title: request.title,
      options: request.options,
      stepId,
      // Shown to the Driver: a step this session already ran is one the agent
      // is asking to do twice, which is what a replayed or injected loop
      // looks like from the outside.
      priorAttempts: this.stepAttempts[stepId] ?? 0,
    };
    this.pendingPermissions.set(request.requestId, payload);
    await this.append("agent", { type: "permission_request", payload });
  }

  /**
   * A participant answers a pending permission request. Only the Driver (the
   * wheel-holder — authority follows the wheel, not the join-time role) may
   * decide; anyone else is privately rejected and the tool stays blocked.
   */
  async decide(
    participantId: string,
    requestId: string,
    outcome: PermissionOutcome,
  ): Promise<void> {
    if (!this.roster.has(participantId)) {
      return;
    }
    if (participantId !== this.driverId) {
      this.deps.broadcaster.sendTo(participantId, {
        kind: "steer_rejected",
        messageId: requestId,
        reason: "only the driver may approve tools",
      });
      return;
    }
    // Unknown/duplicate/already-decided request: drop it, so a tool is never
    // answered twice.
    const pending = this.pendingPermissions.get(requestId);
    if (pending === undefined) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    // An approval is a run of the step, so it takes the next attempt number
    // (read now, not at request time — a step approved in between must not
    // hand out the same key twice). A denial runs nothing and burns nothing.
    let idempotencyKey: IdempotencyKey | undefined;
    if (outcome.kind === "selected") {
      const attempt = (this.stepAttempts[pending.stepId] ?? 0) + 1;
      this.stepAttempts[pending.stepId] = attempt;
      idempotencyKey = { sessionId: this.sessionId, stepId: pending.stepId, attempt };
    }
    await this.append(participantId, {
      type: "permission_decision",
      payload: { requestId, outcome, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) },
    });
    this.deps.agent.respondPermission(requestId, outcome);
  }

  /** The agent's turn ended (naturally or via cancel). */
  async onTurnEnded(
    stopReason: "end_turn" | "max_tokens" | "refusal" | "cancelled",
  ): Promise<void> {
    await this.append("agent", { type: "turn_ended", payload: { stopReason } });
    this.applyEffects(this.steering.onTurnEnded());
  }

  /** Late-joiner / reconnect replay: all events from a sequence offset. */
  replayFrom(fromSeq: number): Promise<SignedEvent[]> {
    return this.deps.store.from(fromSeq);
  }

  /**
   * Compacted replay for a viewer with no history: the newest checkpoint and
   * everything after it. The checkpoint carries the state its elided
   * predecessors would have rebuilt, so this is the whole session as far as
   * the UI is concerned — and it is chained like any other event, so it stays
   * verifiable. Falls back to the full log until the first checkpoint.
   */
  replayFromCheckpoint(): Promise<SignedEvent[]> {
    return this.replayFrom(Math.max(this.lastCheckpointSeq, 0));
  }

  private applyEffects(effects: SteeringEffect[]): void {
    for (const effect of effects) {
      if (effect.kind === "deliver") {
        this.deps.agent.prompt(effect.messages);
        this.steering.onTurnStarted();
      } else {
        this.deps.agent.cancel();
      }
    }
  }

  private async append(authorId: string, body: EventBody): Promise<void> {
    const seq = await this.write(authorId, body);
    if (seq - this.lastCheckpointSeq >= CHECKPOINT_EVERY) {
      await this.checkpoint(seq);
    }
  }

  /**
   * Fold everything through `throughSeq` into one event. Written via `write`,
   * not `append`, so a checkpoint can never trigger another checkpoint.
   */
  private async checkpoint(throughSeq: number): Promise<void> {
    const from = this.lastCheckpointSeq + 1;
    this.lastCheckpointSeq = await this.write("system", {
      type: "checkpoint",
      payload: {
        // Counts only: participant-supplied text (display names, tool titles)
        // stays in the structured fields, where the UI renders it as data
        // rather than as a system line.
        summary: `${throughSeq - from + 1} earlier events (seq ${from}–${throughSeq})`,
        roster: [...this.roster.values()].map((entry) => ({
          participantId: entry.id,
          displayName: entry.displayName,
          role: entry.role,
        })),
        driverId: this.steering.state.driverId,
        pendingPermissions: [...this.pendingPermissions.values()],
      },
    });
  }

  /** Seal one event into the chain, persist it, fan it out. Returns its seq. */
  private async write(authorId: string, body: EventBody): Promise<number> {
    const last = await this.deps.store.last();
    const event = await appendEvent(last === undefined ? [] : [last], {
      authorId,
      body,
      ts: this.deps.now(),
    });
    await this.deps.store.append(event);
    this.deps.broadcaster.broadcast(event);
    return event.seq;
  }
}
