/**
 * Ports the session actor drives. The Durable Object wrapper binds these to
 * SQLite, hibernating WebSockets, and the sandbox ACP bridge; tests bind
 * them to in-memory fakes. Keeping the actor pure of platform APIs is what
 * keeps the Cloudflare-exit hatch in ADR-0001 real.
 */

import type { PermissionOutcome, QueuedMessage, SignedEvent } from "@side-street/core";

export interface EventStore {
  /** The latest event, if any — the chain tip new events link to. */
  last(): Promise<SignedEvent | undefined>;
  append(event: SignedEvent): Promise<void>;
  /** Events with seq >= fromSeq, in order (late-joiner/reconnect replay). */
  from(fromSeq: number): Promise<SignedEvent[]>;
}

export interface Broadcaster {
  /** Fan an appended event out to every connected viewer. */
  broadcast(event: SignedEvent): void;
  /** Deliver a private message (e.g. a steering rejection) to one participant. */
  sendTo(participantId: string, message: PrivateMessage): void;
}

export type PrivateMessage = { kind: "steer_rejected"; messageId: string; reason: string };

/**
 * The agent side of the session. With ACP (ADR-0002) `prompt` during a
 * running turn is realized as cancel-then-reprompt; that mechanism belongs
 * to the bridge, not the actor.
 */
export interface AgentPort {
  prompt(messages: readonly QueuedMessage[]): void;
  cancel(): void;
  /** Answer a pending ACP permission request (the Driver's decision). */
  respondPermission(requestId: string, outcome: PermissionOutcome): void;
}
