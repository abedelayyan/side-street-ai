/**
 * Derive UI state from the event stream: a render-ready timeline (with
 * consecutive agent chunks merged and tool calls collapsed to their latest
 * status), the roster, and the current Driver. Pure so it's testable and so
 * the timeline is always exactly what the log says — no shadow state.
 */

import type { Role, SignedEvent } from "@side-street/core";

export type TimelineItem =
  | { kind: "agent_text"; key: string; text: string }
  | {
      kind: "human";
      key: string;
      authorId: string;
      role: Role | "unknown";
      text: string;
      delivery: "queue" | "interrupt";
    }
  | { kind: "tool"; key: string; title: string; status: string; output?: string | undefined }
  | { kind: "system"; key: string; text: string };

export interface RosterEntry {
  id: string;
  displayName: string;
  role: Role;
}

export interface DerivedSession {
  timeline: TimelineItem[];
  roster: RosterEntry[];
  driverId: string | null;
}

export function deriveSession(events: readonly SignedEvent[]): DerivedSession {
  const timeline: TimelineItem[] = [];
  const roster = new Map<string, RosterEntry>();
  const roles = new Map<string, Role>();
  const toolIndex = new Map<string, number>();
  let driverId: string | null = null;

  for (const event of events) {
    const key = `e${event.seq}`;
    const body = event.body;
    switch (body.type) {
      case "agent_message_chunk": {
        const last = timeline[timeline.length - 1];
        if (last?.kind === "agent_text") {
          last.text += body.payload.text;
        } else {
          timeline.push({ kind: "agent_text", key, text: body.payload.text });
        }
        break;
      }
      case "human_message":
        timeline.push({
          kind: "human",
          key,
          authorId: event.authorId,
          role: roles.get(event.authorId) ?? "unknown",
          text: body.payload.text,
          delivery: body.payload.delivery,
        });
        break;
      case "tool_call": {
        toolIndex.set(body.payload.toolCallId, timeline.length);
        timeline.push({
          kind: "tool",
          key,
          title: body.payload.title,
          status: body.payload.status,
        });
        break;
      }
      case "tool_call_update": {
        const index = toolIndex.get(body.payload.toolCallId);
        const item = index === undefined ? undefined : timeline[index];
        if (item?.kind === "tool") {
          item.status = body.payload.status;
          if (body.payload.output !== undefined) {
            item.output = body.payload.output;
          }
        }
        break;
      }
      case "participant_joined":
        roster.set(body.payload.participantId, {
          id: body.payload.participantId,
          displayName: body.payload.displayName,
          role: body.payload.role,
        });
        roles.set(body.payload.participantId, body.payload.role);
        timeline.push({
          kind: "system",
          key,
          text: `${body.payload.displayName} joined as ${body.payload.role}`,
        });
        break;
      case "participant_left": {
        const entry = roster.get(body.payload.participantId);
        roster.delete(body.payload.participantId);
        if (driverId === body.payload.participantId) {
          driverId = null;
        }
        timeline.push({
          kind: "system",
          key,
          text: `${entry?.displayName ?? body.payload.participantId} left`,
        });
        break;
      }
      case "role_changed": {
        const entry = roster.get(body.payload.participantId);
        if (entry) {
          entry.role = body.payload.role;
        }
        roles.set(body.payload.participantId, body.payload.role);
        break;
      }
      case "control_handoff":
        driverId = body.payload.toParticipantId;
        timeline.push({
          kind: "system",
          key,
          text: `🛞 ${body.payload.toParticipantId} took the wheel`,
        });
        break;
      case "turn_ended":
        if (body.payload.stopReason !== "end_turn") {
          timeline.push({
            kind: "system",
            key,
            text: `turn ended (${body.payload.stopReason})`,
          });
        }
        break;
      case "session_started":
        timeline.push({
          kind: "system",
          key,
          text: `session started · agent: ${body.payload.agent}`,
        });
        break;
      case "permission_request":
      case "permission_decision":
      case "checkpoint":
        break;
    }
  }

  return { timeline, roster: [...roster.values()], driverId };
}
