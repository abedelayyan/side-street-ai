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
import { idempotencyKeySchema } from "./compensation.js";
import { roleSchema } from "./roles.js";

export const SCHEMA_VERSION = 1;

const toolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]);
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>;

/** A Driver's answer to a permission request: pick an option, or cancel (deny). */
export const permissionOutcomeSchema = z.union([
  z.object({ kind: z.literal("selected"), optionId: z.string().min(1) }),
  z.object({ kind: z.literal("cancelled") }),
]);
export type PermissionOutcome = z.infer<typeof permissionOutcomeSchema>;

/** An option the agent offers for a permission request (mirrors ACP options). */
export const permissionOptionSchema = z.object({
  optionId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]).optional(),
});
export type PermissionOption = z.infer<typeof permissionOptionSchema>;

const rosterEntrySchema = z.object({
  participantId: z.string().min(1),
  displayName: z.string().min(1),
  role: roleSchema,
});

export const permissionRequestPayloadSchema = z.object({
  requestId: z.string().min(1),
  toolCallId: z.string().min(1),
  title: z.string().min(1),
  options: z.array(permissionOptionSchema).min(1),
  /** Identifies the action being approved, across retries — see `stepIdFor`. */
  stepId: z.string().min(1),
  /** Times this session already approved this same step. > 0 means a repeat. */
  priorAttempts: z.number().int().nonnegative(),
});
export type PermissionRequestPayload = z.infer<typeof permissionRequestPayloadSchema>;

const agentMessageChunkSchema = z.object({
  type: z.literal("agent_message_chunk"),
  payload: z.object({ text: z.string() }),
});

const toolCallSchema = z.object({
  type: z.literal("tool_call"),
  payload: z.object({
    toolCallId: z.string().min(1),
    title: z.string().min(1),
    status: toolCallStatusSchema,
  }),
});

const toolCallUpdateSchema = z.object({
  type: z.literal("tool_call_update"),
  payload: z.object({
    toolCallId: z.string().min(1),
    status: toolCallStatusSchema,
    output: z.string().optional(),
  }),
});

/**
 * The bodies an agent may author. Everything else in the log describes a human
 * or the session itself, so the agent socket cannot submit it — a
 * prompt-injected agent that controls its own sandbox would otherwise be able
 * to forge a control handoff or a human's message into the attributed log
 * (PLAN.md invariant 2: every event carries a truthful author identity).
 */
export const agentEventBodySchema = z.discriminatedUnion("type", [
  agentMessageChunkSchema,
  toolCallSchema,
  toolCallUpdateSchema,
]);
export type AgentEventBody = z.infer<typeof agentEventBodySchema>;

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
  z.object({ type: z.literal("participant_joined"), payload: rosterEntrySchema }),
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
  agentMessageChunkSchema,
  toolCallSchema,
  toolCallUpdateSchema,
  z.object({
    type: z.literal("human_message"),
    payload: z.object({
      text: z.string().min(1),
      /** "queue" drains at the next tool-call boundary; "interrupt" cancels the turn. */
      delivery: z.enum(["queue", "interrupt"]),
    }),
  }),
  z.object({ type: z.literal("permission_request"), payload: permissionRequestPayloadSchema }),
  z.object({
    type: z.literal("permission_decision"),
    payload: z.object({
      requestId: z.string().min(1),
      outcome: permissionOutcomeSchema,
      /**
       * Present exactly when the decision approves the step: the key that
       * identifies this run of it. A denial runs nothing, so it burns no
       * attempt.
       */
      idempotencyKey: idempotencyKeySchema.optional(),
    }),
  }),
  z.object({
    type: z.literal("turn_ended"),
    payload: z.object({
      stopReason: z.enum(["end_turn", "max_tokens", "refusal", "cancelled"]),
    }),
  }),
  /**
   * A gated step whose outcome the session cannot account for, because the
   * agent process holding it went away (PLAN.md §3.7: replay-or-fork, never
   * blind rollback). We do not guess and we do not re-run: the fact is logged
   * and the humans decide, and re-approving is simply the next attempt.
   */
  z.object({
    type: z.literal("step_unresolved"),
    payload: z.object({
      requestId: z.string().min(1),
      stepId: z.string().min(1),
      title: z.string().min(1),
      /**
       * `approved_unfinished` — it was approved and may have hit a remote
       * system; `never_decided` — nobody had decided, so nothing ran.
       */
      state: z.enum(["approved_unfinished", "never_decided"]),
      /** The key the approval issued; absent when nothing was ever approved. */
      idempotencyKey: idempotencyKeySchema.optional(),
    }),
  }),
  /**
   * A periodic snapshot of derived state, written into the log so a late
   * joiner can start here instead of replaying everything before it. The
   * state is carried in-band rather than fetched out of band precisely
   * because the log is hash-chained: a compacted replay is exactly as
   * tamper-evident as a full one.
   */
  z.object({
    type: z.literal("checkpoint"),
    payload: z.object({
      /** Human-readable gap marker. Never interpolates participant-supplied text. */
      summary: z.string().min(1),
      roster: z.array(rosterEntrySchema),
      driverId: z.string().min(1).nullable(),
      /** Requests the agent is still blocked on, so a late joiner can answer them. */
      pendingPermissions: z.array(permissionRequestPayloadSchema),
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
