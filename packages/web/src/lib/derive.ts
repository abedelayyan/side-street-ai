/**
 * Derive UI state from the event stream: a render-ready timeline (with
 * consecutive agent chunks merged and tool calls collapsed to their latest
 * status), the roster, and the current Driver. Pure so it's testable and so
 * the timeline is always exactly what the log says — no shadow state.
 */

import type { PermissionOption, Role, SignedEvent } from "@side-street/core";

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

/** A permission request the agent is blocked on, awaiting a Driver decision. */
export interface PendingPermission {
  requestId: string;
  title: string;
  options: PermissionOption[];
}

export interface DerivedSession {
  timeline: TimelineItem[];
  roster: RosterEntry[];
  driverId: string | null;
  pendingPermissions: PendingPermission[];
}

export function deriveSession(events: readonly SignedEvent[]): DerivedSession {
  const timeline: TimelineItem[] = [];
  const roster = new Map<string, RosterEntry>();
  const roles = new Map<string, Role>();
  const toolIndex = new Map<string, number>();
  const pendingPermissions = new Map<string, PendingPermission>();
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
        pendingPermissions.set(body.payload.requestId, {
          requestId: body.payload.requestId,
          title: body.payload.title,
          options: body.payload.options,
        });
        timeline.push({
          kind: "system",
          key,
          text: `🔒 approval requested: ${body.payload.title}`,
        });
        break;
      case "permission_decision": {
        pendingPermissions.delete(body.payload.requestId);
        const text =
          body.payload.outcome.kind === "selected"
            ? `🔓 tool approved (${body.payload.outcome.optionId})`
            : "🚫 tool denied";
        timeline.push({ kind: "system", key, text });
        break;
      }
      case "checkpoint": {
        // The state the elided events would have produced. Re-applying it
        // mid-stream is a no-op for a viewer who watched them go by.
        for (const entry of body.payload.roster) {
          roster.set(entry.participantId, {
            id: entry.participantId,
            displayName: entry.displayName,
            role: entry.role,
          });
          roles.set(entry.participantId, entry.role);
        }
        driverId = body.payload.driverId;
        for (const request of body.payload.pendingPermissions) {
          pendingPermissions.set(request.requestId, {
            requestId: request.requestId,
            title: request.title,
            options: request.options,
          });
        }
        // Mark the gap only when the checkpoint opens the stream — that is
        // the one case where history is actually missing from the timeline.
        if (timeline.length === 0) {
          timeline.push({ kind: "system", key, text: `⋯ ${body.payload.summary}` });
        }
        break;
      }
    }
  }

  return {
    timeline,
    roster: [...roster.values()],
    driverId,
    pendingPermissions: [...pendingPermissions.values()],
  };
}
