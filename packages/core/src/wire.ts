/**
 * Wire-protocol frames (docs/protocol.md, "Transport"). Shared by the
 * Durable Object (server side) and the sandbox agent bridge / web client
 * (connecting sides). Every frame crosses a trust boundary, so both ends
 * parse with these schemas rather than casting.
 */

import { z } from "zod";
import {
  eventBodySchema,
  permissionOptionSchema,
  permissionOutcomeSchema,
  signedEventSchema,
} from "./events.js";
import { roleSchema } from "./roles.js";

/** Schema mirror of the steering engine's QueuedMessage, for frame parsing. */
export const queuedMessageSchema = z.object({
  id: z.string().min(1),
  authorId: z.string().min(1),
  role: roleSchema,
  text: z.string().min(1),
  queuedAt: z.number().int().nonnegative(),
});

// Viewer → server
export const viewerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("steer"),
    id: z.string().min(1),
    text: z.string().min(1),
    delivery: z.enum(["queue", "interrupt"]),
  }),
  z.object({
    type: z.literal("handoff"),
    toParticipantId: z.string().min(1),
  }),
  z.object({
    type: z.literal("decide"),
    requestId: z.string().min(1),
    outcome: permissionOutcomeSchema,
  }),
]);
export type ViewerFrame = z.infer<typeof viewerFrameSchema>;

// Server → viewer
export const serverFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    participantId: z.string().min(1),
    role: roleSchema,
    lastSeq: z.number().int().gte(-1),
  }),
  z.object({ type: z.literal("event"), event: signedEventSchema }),
  z.object({
    type: z.literal("steer_rejected"),
    messageId: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({ type: z.literal("error"), message: z.string().min(1) }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

// Agent bridge → server
export const agentFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_event"), body: eventBodySchema }),
  z.object({
    type: z.literal("turn_ended"),
    stopReason: z.enum(["end_turn", "max_tokens", "refusal", "cancelled"]),
  }),
  z.object({
    type: z.literal("permission_request"),
    requestId: z.string().min(1),
    toolCallId: z.string().min(1),
    title: z.string().min(1),
    options: z.array(permissionOptionSchema).min(1),
  }),
  // The credentials injected into the sandbox, declared so the redaction pass
  // can strip them by exact value. These never enter an event or a prompt;
  // the bound keeps one frame from ballooning the redaction set.
  z.object({
    type: z.literal("register_secrets"),
    values: z.array(z.string().min(1)).min(1).max(64),
  }),
]);
export type AgentFrame = z.infer<typeof agentFrameSchema>;

// Server → agent bridge
export const agentServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), messages: z.array(queuedMessageSchema).min(1) }),
  z.object({ type: z.literal("cancel") }),
  z.object({
    type: z.literal("permission_decision"),
    requestId: z.string().min(1),
    outcome: permissionOutcomeSchema,
  }),
]);
export type AgentServerFrame = z.infer<typeof agentServerFrameSchema>;

export const joinParamsSchema = z.object({
  participantId: z.string().min(1),
  displayName: z.string().min(1),
  role: roleSchema,
});
export type JoinParams = z.infer<typeof joinParamsSchema>;

export const replayResponseSchema = z.object({ events: z.array(signedEventSchema) });
