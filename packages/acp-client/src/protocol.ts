/**
 * Zod schemas for the ACP subset Side Street speaks (ADR-0002).
 *
 * Incoming frames are untrusted (they cross the sandbox boundary), so every
 * message is validated before dispatch. Unknown update variants pass through
 * as `unknown_update` rather than throwing: agents evolve faster than we
 * ship, and a viewer losing one chunk kind must not kill the session.
 */

import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const idSchema = z.union([z.string(), z.number()]);

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: idSchema,
  method: z.string(),
  params: z.unknown().optional(),
});

export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});

export const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: idSchema,
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});

export type JsonRpcId = z.infer<typeof idSchema>;

export const contentBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const stopReasonSchema = z.enum(["end_turn", "max_tokens", "refusal", "cancelled"]);
export type StopReason = z.infer<typeof stopReasonSchema>;

const toolCallStatusSchema = z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]);

export const sessionUpdateSchema = z.union([
  z.object({
    sessionUpdate: z.literal("agent_message_chunk"),
    content: contentBlockSchema,
  }),
  z.object({
    sessionUpdate: z.literal("tool_call"),
    toolCallId: z.string(),
    title: z.string(),
    status: toolCallStatusSchema.default("pending"),
  }),
  z.object({
    sessionUpdate: z.literal("tool_call_update"),
    toolCallId: z.string(),
    status: toolCallStatusSchema,
    content: z.array(contentBlockSchema).optional(),
  }),
  // Forward compatibility: keep unknown kinds observable without failing.
  z
    .object({ sessionUpdate: z.string() })
    .passthrough()
    .transform((raw) => ({ sessionUpdate: "unknown_update" as const, raw })),
]);

export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;

export const sessionUpdateParamsSchema = z.object({
  sessionId: z.string(),
  update: sessionUpdateSchema,
});

export const promptResultSchema = z.object({ stopReason: stopReasonSchema });

export const newSessionResultSchema = z.object({ sessionId: z.string() });

export const initializeResultSchema = z.object({ protocolVersion: z.number() }).passthrough();

export const permissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]).optional(),
});

export const permissionRequestParamsSchema = z.object({
  sessionId: z.string(),
  toolCall: z.object({ toolCallId: z.string(), title: z.string().optional() }).passthrough(),
  options: z.array(permissionOptionSchema).min(1),
});

export type PermissionRequestParams = z.infer<typeof permissionRequestParamsSchema>;

export type PermissionOutcome =
  { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
