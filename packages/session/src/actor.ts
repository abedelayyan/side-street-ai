/**
 * The session actor (PLAN.md §3): single writer of the append-only event
 * log, owner of the roster and steering state, fan-out point for viewers.
 * One instance exists per session (the Durable Object guarantees this in
 * production); all methods assume single-threaded execution.
 */

import {
  SteeringController,
  appendEvent,
  type EventBody,
  type Role,
  type SignedEvent,
  type SteeringEffect,
  type SteeringState,
} from "@side-street/core";
import type { AgentPort, Broadcaster, EventStore } from "./ports.js";

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
}

export type SteerInput = { id: string; text: string; delivery: "queue" | "interrupt" };

export class SessionActor {
  private readonly steering: SteeringController;
  private readonly roster = new Map<string, RosterEntry>();

  constructor(
    private readonly deps: SessionActorDeps,
    snapshot?: SessionActorSnapshot,
  ) {
    this.steering = new SteeringController(snapshot?.steering);
    for (const entry of snapshot?.roster ?? []) {
      this.roster.set(entry.id, entry);
    }
  }

  /** Serializable state for the wrapper to persist alongside the event log. */
  get snapshot(): SessionActorSnapshot {
    return { steering: this.steering.state, roster: [...this.roster.values()] };
  }

  get driverId(): string | null {
    return this.steering.state.driverId;
  }

  async start(sessionId: string, agent: string, sandboxProvider: string): Promise<void> {
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
    const last = await this.deps.store.last();
    const event = await appendEvent(last === undefined ? [] : [last], {
      authorId,
      body,
      ts: this.deps.now(),
    });
    await this.deps.store.append(event);
    this.deps.broadcaster.broadcast(event);
  }
}
