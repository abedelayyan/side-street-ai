/**
 * The bridge runner: the process that turns the tested-in-isolation pieces
 * into a live session. It spawns a real ACP agent (claude-code-acp by
 * default), opens the session's `/agent` WebSocket, and wires both into
 * AgentBridge. This is what runs inside the sandbox in production and on a
 * dev machine for the Phase 1 exit benchmark.
 */

import {
  AcpClient,
  type PermissionOutcome,
  type PermissionRequestParams,
} from "@side-street/acp-client";
import { AgentBridge, type SessionSocket } from "./bridge.js";
import { spawnAgent } from "./stdio.js";

/** `http(s)://host/session/:id` → `ws(s)://host/session/:id/agent`. */
export function agentSocketUrl(sessionUrl: string): string {
  const url = new URL(sessionUrl);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/agent`;
  return url.toString();
}

/**
 * v0 permission policy: auto-select the narrowest allow option, deny when
 * none exists. Driver-gated approval surfaced through the session is a
 * Phase 2 deliverable (PLAN.md) — until then the runner must never block a
 * local dev turn waiting on a decision nobody can deliver.
 */
export function decidePermission(params: PermissionRequestParams): PermissionOutcome {
  const allow =
    params.options.find((option) => option.kind === "allow_once") ??
    params.options.find((option) => option.kind === "allow_always");
  return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
}

/** The structural slice of WebSocket the runner needs (keeps tests socket-free). */
export interface WebSocketLike {
  send(data: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export function sessionSocketFromWebSocket(ws: WebSocketLike): SessionSocket {
  return {
    send(frame): void {
      ws.send(JSON.stringify(frame));
    },
    onFrame(handler): void {
      ws.addEventListener("message", (event) => {
        let frame: unknown = event.data;
        if (typeof event.data === "string") {
          try {
            frame = JSON.parse(event.data);
          } catch {
            // Deliver raw; the bridge's schema layer reports it as malformed.
          }
        }
        handler(frame);
      });
    },
  };
}

const DEFAULT_AGENT_COMMAND = ["npx", "--yes", "@agentclientprotocol/claude-agent-acp"];

export async function main(argv: readonly string[]): Promise<void> {
  const [sessionUrl, workspace, ...agentCommand] = argv;
  if (sessionUrl === undefined || workspace === undefined) {
    console.error(
      "Usage: runner <session-url> <workspace-dir> [agent-command...]\n" +
        "  e.g. runner http://localhost:8787/session/demo ../sample-repo",
    );
    process.exitCode = 1;
    return;
  }
  const [command, ...args] = agentCommand.length > 0 ? agentCommand : DEFAULT_AGENT_COMMAND;

  const agent = spawnAgent(command as string, args, {
    cwd: workspace,
    shell: process.platform === "win32",
  });
  void agent.exited.then((code) => {
    console.error(`agent process exited (${code ?? "signal"})`);
    process.exit(code ?? 1);
  });

  let bridge: AgentBridge | undefined = undefined;
  const client = new AcpClient(agent.transport, {
    onSessionUpdate(_sessionId, update): void {
      bridge?.onSessionUpdate(update);
    },
    onPermissionRequest(params): Promise<PermissionOutcome> {
      const outcome = decidePermission(params);
      console.error(
        `permission ${params.toolCall.toolCallId} (${params.toolCall.title ?? "untitled"}): ${outcome.outcome}`,
      );
      return Promise.resolve(outcome);
    },
    onError(error): void {
      console.error(`acp: ${error.message}`);
    },
  });

  await client.initialize();
  const acpSessionId = await client.newSession({ cwd: workspace });
  console.error(`agent ready (acp session ${acpSessionId})`);

  const wsUrl = agentSocketUrl(sessionUrl);
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`cannot connect to ${wsUrl}`)), {
      once: true,
    });
  });
  ws.addEventListener("close", () => {
    // ponytail: exit on disconnect and rerun; the DO buffers prompts while
    // the bridge is away. In-process reconnect can come with the E2B adapter.
    console.error("session socket closed");
    agent.kill();
    process.exit(1);
  });

  bridge = new AgentBridge({
    socket: sessionSocketFromWebSocket(ws),
    agent: client,
    acpSessionId,
    onError(error): void {
      console.error(`bridge: ${error.message}`);
    },
  });
  console.error(`bridge connected to ${wsUrl}`);
}
