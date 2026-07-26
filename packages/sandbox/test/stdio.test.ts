import { afterEach, describe, expect, it } from "vitest";
import { spawnAgent, type AgentProcess } from "../src/stdio.js";

/**
 * A line-oriented echo peer: valid JSON lines come back as {"echo": ...};
 * the literal command "garble" makes it emit a non-JSON line.
 */
const ECHO_SCRIPT = `
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (parsed === "garble") process.stdout.write("not json\\n");
      else process.stdout.write(JSON.stringify({ echo: parsed }) + "\\n");
    }
  });
`;

function nextMessage(agent: AgentProcess): Promise<unknown> {
  return new Promise((resolve) => agent.transport.onMessage(resolve));
}

describe("spawnAgent stdio transport", () => {
  let agent: AgentProcess | undefined;
  afterEach(() => agent?.kill());

  it("round-trips newline-delimited JSON messages", async () => {
    agent = spawnAgent(process.execPath, ["-e", ECHO_SCRIPT]);
    const received = nextMessage(agent);
    agent.transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await expect(received).resolves.toEqual({
      echo: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
  });

  it("delivers non-JSON lines raw instead of throwing", async () => {
    agent = spawnAgent(process.execPath, ["-e", ECHO_SCRIPT]);
    const received = nextMessage(agent);
    agent.transport.send("garble");
    await expect(received).resolves.toBe("not json");
  });

  it("resolves exited when the process ends", async () => {
    agent = spawnAgent(process.execPath, ["-e", "process.exit(3)"]);
    await expect(agent.exited).resolves.toBe(3);
  });
});
