/**
 * The multi-human steering engine (PLAN.md §3, Phase 1).
 *
 * Extends the industry-consensus single-user mechanism — queue input, drain
 * at the next tool-call boundary, explicit hard-interrupt — to N humans with
 * roles. Single-Driver authority is a correctness requirement: concurrent
 * injection into one context window produces incoherent prompts, so only the
 * Driver initiates turns and interrupts; Navigator suggestions ride along,
 * Observers are read-only.
 *
 * This module is a pure state machine. It never talks to an agent: callers
 * (the session actor) apply the returned effects, which keeps the mechanism
 * agnostic to how injection is realized (ACP today is cancel-then-reprompt
 * at turn granularity; a native mid-turn channel can slot in later).
 */

import type { Role } from "./roles.js";
import { canSteer, canSuggest } from "./roles.js";

export interface Participant {
  id: string;
  role: Role;
}

export interface QueuedMessage {
  /** Caller-supplied unique id, echoed in effects for attribution. */
  id: string;
  authorId: string;
  /** The author's role at submission time — attribution must survive later role changes. */
  role: Role;
  text: string;
  queuedAt: number;
}

export type TurnPhase = "idle" | "running" | "cancelling";

export interface SteeringState {
  driverId: string | null;
  turnPhase: TurnPhase;
  queue: readonly QueuedMessage[];
}

export type SteeringEffect =
  /** Deliver these attributed messages to the agent (start a turn or inject at a boundary). */
  | { kind: "deliver"; messages: QueuedMessage[] }
  /** Hard-interrupt the running turn (ACP session/cancel). */
  | { kind: "cancel_turn" };

export type SubmitResult =
  { accepted: true; effects: SteeringEffect[] } | { accepted: false; reason: string };

export type HandoffResult = { ok: true } | { ok: false; reason: string };

export class SteeringController {
  private driverId: string | null;
  private turnPhase: TurnPhase = "idle";
  private queue: QueuedMessage[] = [];

  constructor(initialState?: SteeringState) {
    this.driverId = initialState?.driverId ?? null;
    this.turnPhase = initialState?.turnPhase ?? "idle";
    this.queue = initialState ? [...initialState.queue] : [];
  }

  /** Serializable snapshot for persistence in the session actor. */
  get state(): SteeringState {
    return { driverId: this.driverId, turnPhase: this.turnPhase, queue: [...this.queue] };
  }

  /**
   * A participant submits a message. Driver messages steer; Navigator
   * messages queue as suggestions and never initiate a turn on their own;
   * Observer messages are rejected. `delivery: "interrupt"` (Driver only)
   * cancels the running turn and re-prompts with everything queued.
   */
  submit(
    participant: Participant,
    message: { id: string; text: string; delivery: "queue" | "interrupt" },
    now: number,
  ): SubmitResult {
    if (!canSuggest(participant.role)) {
      return { accepted: false, reason: "observers are read-only" };
    }
    const isDriver = canSteer(participant.role) && participant.id === this.driverId;
    if (canSteer(participant.role) && participant.id !== this.driverId) {
      return { accepted: false, reason: "not the current driver — take the wheel first" };
    }
    if (message.delivery === "interrupt" && !isDriver) {
      return { accepted: false, reason: "only the driver may interrupt" };
    }

    this.queue.push({
      id: message.id,
      authorId: participant.id,
      role: participant.role,
      text: message.text,
      queuedAt: now,
    });

    if (message.delivery === "interrupt") {
      if (this.turnPhase === "running") {
        this.turnPhase = "cancelling";
        return { accepted: true, effects: [{ kind: "cancel_turn" }] };
      }
      if (this.turnPhase === "cancelling") {
        // A cancel is already in flight; the queued message rides the re-prompt.
        return { accepted: true, effects: [] };
      }
      return { accepted: true, effects: this.drainForDelivery() };
    }

    // Queued delivery: a Driver message starts a turn immediately when the
    // agent is idle; otherwise everything waits for the next boundary.
    if (isDriver && this.turnPhase === "idle") {
      return { accepted: true, effects: this.drainForDelivery() };
    }
    return { accepted: true, effects: [] };
  }

  /**
   * The agent reached a tool-call boundary mid-turn. Drain anything queued
   * so the session actor can inject it.
   */
  onToolCallBoundary(): SteeringEffect[] {
    if (this.turnPhase !== "running" || this.queue.length === 0) {
      return [];
    }
    return this.drainForDelivery();
  }

  /** The session actor sent a prompt to the agent. */
  onTurnStarted(): void {
    this.turnPhase = "running";
  }

  /**
   * The agent's turn ended. After a cancelled turn (hard-interrupt) or a
   * natural end with messages waiting, the queue drains as the next prompt.
   */
  onTurnEnded(): SteeringEffect[] {
    this.turnPhase = "idle";
    if (this.queue.length === 0) {
      return [];
    }
    // Suggestions alone don't start a turn; they wait for the Driver.
    if (!this.queue.some((m) => m.role === "driver")) {
      return [];
    }
    return this.drainForDelivery();
  }

  /**
   * Explicit control handoff ("take the wheel"). The current Driver hands
   * off, or anyone with a steering-capable role claims a driverless wheel.
   */
  handoff(requestedBy: Participant, toParticipantId: string): HandoffResult {
    if (this.driverId !== null && requestedBy.id !== this.driverId) {
      return { ok: false, reason: "only the current driver may hand off control" };
    }
    if (this.driverId === null && !canSuggest(requestedBy.role)) {
      return { ok: false, reason: "observers cannot claim the wheel" };
    }
    this.driverId = toParticipantId;
    return { ok: true };
  }

  /** The Driver left the session; the wheel is free to claim. */
  releaseWheel(participantId: string): void {
    if (this.driverId === participantId) {
      this.driverId = null;
    }
  }

  private drainForDelivery(): SteeringEffect[] {
    // Driver messages lead, suggestions follow; submission order is kept
    // within each group so the agent reads a coherent instruction first.
    const drivers = this.queue.filter((m) => m.role === "driver");
    const suggestions = this.queue.filter((m) => m.role !== "driver");
    this.queue = [];
    return [{ kind: "deliver", messages: [...drivers, ...suggestions] }];
  }
}
