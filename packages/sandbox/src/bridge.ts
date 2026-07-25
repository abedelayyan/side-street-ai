/**
 * The agent bridge: runs beside the ACP agent inside the sandbox and
 * connects it to the session Durable Object's `/agent` socket.
 *
 * It realizes the steering semantics ACP cannot express directly
 * (ADR-0002). ACP has no mid-turn injection, so a `prompt` frame arriving
 * while a turn runs becomes cancel-then-reprompt — and that internal cancel
 * is invisible to the session: no `turn_ended` is reported, the next prompt
 * simply continues the turn. Only a natural stop or an explicit `cancel`
 * frame (the Driver's hard-interrupt) ends the session-level turn.
 */

import { agentServerFrameSchema, type AgentFrame, type QueuedMessage } from "@side-street/core";
import {
  toEventBody,
  type ContentBlock,
  type SessionUpdate,
  type StopReason,
} from "@side-street/acp-client";

/** The bridge's connection to the session (the DO's `/agent` endpoint). */
export interface SessionSocket {
  send(frame: AgentFrame): void;
  onFrame(handler: (frame: unknown) => void): void;
}

/** The slice of AcpClient the bridge drives (kept narrow for testability). */
export interface PromptingAgent {
  prompt(sessionId: string, prompt: ContentBlock[]): Promise<StopReason>;
  cancel(sessionId: string): void;
}

export interface AgentBridgeOptions {
  socket: SessionSocket;
  agent: PromptingAgent;
  /** The ACP session id obtained from session/new. */
  acpSessionId: string;
  onError?(error: Error): void;
}

type TurnState =
  { phase: "idle" } | { phase: "running"; injection: QueuedMessage[]; hardCancelled: boolean };

export class AgentBridge {
  private state: TurnState = { phase: "idle" };

  constructor(private readonly options: AgentBridgeOptions) {
    options.socket.onFrame((raw) => {
      this.handleFrame(raw);
    });
  }

  /** Forward an ACP session update into the session's event log. */
  onSessionUpdate(update: SessionUpdate): void {
    const body = toEventBody(update);
    if (body !== null) {
      this.send({ type: "agent_event", body });
    }
  }

  private handleFrame(raw: unknown): void {
    const frame = agentServerFrameSchema.safeParse(raw);
    if (!frame.success) {
      this.options.onError?.(new Error(`malformed session frame: ${frame.error.message}`));
      return;
    }
    if (frame.data.type === "cancel") {
      if (this.state.phase === "running") {
        this.state.hardCancelled = true;
        this.options.agent.cancel(this.options.acpSessionId);
      }
      return;
    }
    // prompt frame
    if (this.state.phase === "running") {
      // Mid-turn injection: queue it and cancel the in-flight ACP turn; the
      // runTurn loop re-prompts with these messages without ending the
      // session-level turn.
      this.state.injection.push(...frame.data.messages);
      this.options.agent.cancel(this.options.acpSessionId);
      return;
    }
    void this.runTurn(frame.data.messages);
  }

  private async runTurn(initial: QueuedMessage[]): Promise<void> {
    this.state = { phase: "running", injection: [], hardCancelled: false };
    let messages = initial;
    try {
      for (;;) {
        const stopReason = await this.options.agent.prompt(
          this.options.acpSessionId,
          formatPrompt(messages),
        );
        if (this.state.phase !== "running") {
          return; // Defensive: state was torn down externally.
        }
        if (stopReason === "cancelled" && !this.state.hardCancelled) {
          if (this.state.injection.length > 0) {
            // Internal cancel for injection: continue the same session turn.
            messages = this.state.injection;
            this.state.injection = [];
            continue;
          }
          // Cancelled with nothing to inject (e.g. agent-side abort): report it.
        }
        this.state = { phase: "idle" };
        this.send({ type: "turn_ended", stopReason });
        return;
      }
    } catch (error) {
      this.state = { phase: "idle" };
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.send({ type: "turn_ended", stopReason: "cancelled" });
    }
  }

  private send(frame: AgentFrame): void {
    this.options.socket.send(frame);
  }
}

/**
 * Render attributed messages for the agent. The Driver's instruction leads,
 * verbatim and authoritative; other voices are labelled suggestions so the
 * agent can weigh them without confusing who is in charge.
 */
export function formatPrompt(messages: readonly QueuedMessage[]): ContentBlock[] {
  return messages.map((message) => ({
    type: "text",
    text:
      message.role === "driver"
        ? message.text
        : `[Suggestion from ${message.authorId}]: ${message.text}`,
  }));
}
