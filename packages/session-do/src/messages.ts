/**
 * WebSocket wire frames (docs/protocol.md, "Transport" section). Two socket
 * kinds attach to a session Durable Object:
 *
 * - Viewer sockets (`/session/:id/ws`): humans watching and steering.
 * - The agent socket (`/session/:id/agent`): the sandbox-side ACP bridge.
 *
 * Every inbound frame crosses a trust boundary and is zod-validated before
 * dispatch. Authentication of both socket kinds is a Phase 2 deliverable;
 * v0 identifies participants by query parameters and must not be exposed
 * beyond development environments.
 */

import {
  eventBodySchema,
  roleSchema,
  signedEventSchema,
  type SignedEvent,
} from "@side-street/core";
import type { QueuedMessage } from "@side-street/core";
import { z } from "zod";

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
]);
export type ViewerFrame = z.infer<typeof viewerFrameSchema>;

// Server → viewer
export type ServerFrame =
  | { type: "welcome"; participantId: string; role: string; lastSeq: number }
  | { type: "event"; event: SignedEvent }
  | { type: "steer_rejected"; messageId: string; reason: string }
  | { type: "error"; message: string };

// Agent bridge → server
export const agentFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_event"), body: eventBodySchema }),
  z.object({
    type: z.literal("turn_ended"),
    stopReason: z.enum(["end_turn", "max_tokens", "refusal", "cancelled"]),
  }),
]);
export type AgentFrame = z.infer<typeof agentFrameSchema>;

// Server → agent bridge
export type AgentServerFrame = { type: "prompt"; messages: QueuedMessage[] } | { type: "cancel" };

export const joinParamsSchema = z.object({
  participantId: z.string().min(1),
  displayName: z.string().min(1),
  role: roleSchema,
});

export const replayResponseSchema = z.object({ events: z.array(signedEventSchema) });
