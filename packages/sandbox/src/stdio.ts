/**
 * Stdio transport for a local ACP agent process: newline-delimited JSON-RPC
 * over the child's stdin/stdout, per the ACP wire format. Stderr passes
 * through to ours so agent diagnostics stay visible.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Transport } from "@side-street/acp-client";

export interface SpawnAgentOptions {
  cwd?: string;
  /** Run via a shell — needed for `.cmd` shims like npx on Windows. */
  shell?: boolean;
}

export interface AgentProcess {
  transport: Transport;
  /** Resolves with the exit code when the agent process ends. */
  exited: Promise<number | null>;
  kill(): void;
}

export function spawnAgent(
  command: string,
  args: readonly string[],
  options: SpawnAgentOptions = {},
): AgentProcess {
  const stdio: ["pipe", "pipe", "inherit"] = ["pipe", "pipe", "inherit"];
  // A shell takes one command line (separate args would be concatenated
  // unescaped — DEP0190), so quote and join when shell is requested.
  const child = options.shell
    ? spawn([command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "), {
        stdio,
        cwd: options.cwd,
        shell: true,
      })
    : spawn(command, [...args], { stdio, cwd: options.cwd });

  let handler: (message: unknown) => void = () => {};
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.trim() === "") {
      return;
    }
    let message: unknown = line;
    try {
      message = JSON.parse(line);
    } catch {
      // Deliver the raw line; the client's schema layer reports it as malformed.
    }
    handler(message);
  });

  return {
    transport: {
      send(message: unknown): void {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      onMessage(h: (message: unknown) => void): void {
        handler = h;
      },
      close(): void {
        child.stdin.end();
      },
    },
    exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))),
    kill(): void {
      child.kill();
    },
  };
}
