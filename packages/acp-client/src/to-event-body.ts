/**
 * Translate ACP session updates into Side Street event bodies so the session
 * actor can append them to the log without knowing ACP shapes.
 */

import type { AgentEventBody, EventBody } from "@side-street/core";
import type { SessionUpdate, StopReason } from "./protocol.js";

/** Returns null for update kinds that don't map to a logged event (yet). */
export function toEventBody(update: SessionUpdate): AgentEventBody | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return { type: "agent_message_chunk", payload: { text: update.content.text } };
    case "tool_call":
      return {
        type: "tool_call",
        payload: { toolCallId: update.toolCallId, title: update.title, status: update.status },
      };
    case "tool_call_update": {
      const output = update.content?.map((block) => block.text).join("");
      return {
        type: "tool_call_update",
        payload: {
          toolCallId: update.toolCallId,
          status: update.status,
          ...(output === undefined ? {} : { output }),
        },
      };
    }
    case "unknown_update":
      return null;
  }
}

export function turnEndedBody(stopReason: StopReason): EventBody {
  return { type: "turn_ended", payload: { stopReason } };
}
