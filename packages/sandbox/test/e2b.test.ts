import { describe, expect, it } from "vitest";
import { Sandbox } from "e2b";
import { E2bProvider, SANDBOX_REPO_PATH } from "../src/e2b.js";

const hasKey = typeof process.env.E2B_API_KEY === "string" && process.env.E2B_API_KEY !== "";

// Integration test: talks to the real E2B API. Skipped without E2B_API_KEY
// (CI stays green); run locally with the key to exercise the adapter.
describe.skipIf(!hasKey)("E2bProvider (integration)", () => {
  it("boots a microVM with the repo cloned and env injected, then stops it", async () => {
    const provider = new E2bProvider({ timeoutMs: 180_000 });
    const handle = await provider.launch({
      sessionId: "e2b-adapter-test",
      repoUrl: "https://github.com/abedelayyan/side-street-ai.git",
      env: { SIDE_STREET_MARKER: "e2b-adapter-test" },
    });

    try {
      expect(handle.id).toBeTruthy();
      await expect(handle.status()).resolves.toBe("running");

      const sandbox = await Sandbox.connect(handle.id);
      const cloned = await sandbox.commands.run(`ls ${SANDBOX_REPO_PATH}`);
      expect(cloned.stdout).toContain("package.json");
      const env = await sandbox.commands.run("echo $SIDE_STREET_MARKER");
      expect(env.stdout.trim()).toBe("e2b-adapter-test");
    } finally {
      await handle.stop();
    }

    await expect(handle.status()).resolves.toBe("stopped");
    // stop() is idempotent per the SandboxHandle contract.
    await expect(handle.stop()).resolves.toBeUndefined();
  }, 180_000);

  it("kills the sandbox instead of leaking it when the clone fails", async () => {
    const provider = new E2bProvider({ timeoutMs: 60_000 });
    await expect(
      provider.launch({
        sessionId: "e2b-adapter-test-bad-repo",
        repoUrl: "https://github.com/abedelayyan/does-not-exist-404.git",
        env: {},
      }),
    ).rejects.toThrow();
    // The failed launch's sandbox must not survive it.
    const leaked = await Sandbox.list({
      query: { metadata: { sideStreetSessionId: "e2b-adapter-test-bad-repo" } },
    }).nextItems();
    expect(leaked).toHaveLength(0);
  }, 120_000);
});
