/**
 * The session event protocol (PLAN.md §3).
 *
 * Every observable fact about a session — agent output, tool activity, human
 * steering, role changes, approvals — is one ordered event in an append-only
 * log. Events are never mutated or deleted; corrections are new events.
 * The envelope mirrors the Durable Object SQLite schema:
 * events(seq, ts, author_id, type, payload, prev_hash, hash).
 */

import { z } from "zod";
import { roleSchema } from "./roles.js";

export const SCHEMA_VERSION = 1;

const toolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]);
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>;

/**
 * Discriminated union of event bodies. Extend by adding variants; never
 * repurpose an existing `type` — replayability of old logs depends on it.
 */
export const eventBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_started"),
    payload: z.object({
      sessionId: z.string().min(1),
      agent: z.string().min(1),
      sandboxProvider: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("participant_joined"),
    payload: z.object({
      participantId: z.string().min(1),
      displayName: z.string().min(1),
      role: roleSchema,
    }),
  }),
  z.object({
    type: z.literal("participant_left"),
    payload: z.object({ participantId: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("role_changed"),
    payload: z.object({ participantId: z.string().min(1), role: roleSchema }),
  }),
  z.object({
    type: z.literal("control_handoff"),
    payload: z.object({ fromParticipantId: z.string().min(1), toParticipantId: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("agent_message_chunk"),
    payload: z.object({ text: z.string() }),
  }),
  z.object({
    type: z.literal("tool_call"),
    payload: z.object({
      toolCallId: z.string().min(1),
      title: z.string().min(1),
      status: toolCallStatusSchema,
    }),
  }),
  z.object({
    type: z.literal("tool_call_update"),
    payload: z.object({
      toolCallId: z.string().min(1),
      status: toolCallStatusSchema,
      output: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("human_message"),
    payload: z.object({
      text: z.string().min(1),
      /** "queue" drains at the next tool-call boundary; "interrupt" cancels the turn. */
      delivery: z.enum(["queue", "interrupt"]),
    }),
  }),
  z.object({
    type: z.literal("permission_request"),
    payload: z.object({
      requestId: z.string().min(1),
      toolCallId: z.string().min(1),
      optionIds: z.array(z.string().min(1)).min(1),
    }),
  }),
  z.object({
    type: z.literal("permission_decision"),
    payload: z.object({
      requestId: z.string().min(1),
      outcome: z.union([
        z.object({ kind: z.literal("selected"), optionId: z.string().min(1) }),
        z.object({ kind: z.literal("cancelled") }),
      ]),
    }),
  }),
  z.object({
    type: z.literal("turn_ended"),
    payload: z.object({
      stopReason: z.enum(["end_turn", "max_tokens", "refusal", "cancelled"]),
    }),
  }),
  z.object({
    type: z.literal("checkpoint"),
    payload: z.object({
      summary: z.string().min(1),
      /** Reference to an externally stored snapshot (e.g. R2 key), if any. */
      snapshotRef: z.string().optional(),
    }),
  }),
]);

export type EventBody = z.infer<typeof eventBodySchema>;
export type EventType = EventBody["type"];

/** An event before it is sealed into the chain. `prevHash` binds it to its predecessor. */
export const unsignedEventSchema = z.object({
  v: z.literal(SCHEMA_VERSION),
  seq: z.number().int().nonnegative(),
  /** Milliseconds since Unix epoch, assigned by the session actor (single writer). */
  ts: z.number().int().nonnegative(),
  /** Participant id, or "agent" / "system" for non-human authors. */
  authorId: z.string().min(1),
  body: eventBodySchema,
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type UnsignedEvent = z.infer<typeof unsignedEventSchema>;

export const signedEventSchema = unsignedEventSchema.extend({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type SignedEvent = z.infer<typeof signedEventSchema>;
