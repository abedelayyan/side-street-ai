/**
 * E2B adapter for the SandboxProvider interface (PLAN.md Phase 1): one
 * Firecracker microVM per session, repo cloned before the agent starts,
 * session credentials injected as boot environment — never logged, never
 * prompted. The SDK reads E2B_API_KEY from the environment.
 */

import { Sandbox } from "e2b";
import type {
  SandboxHandle,
  SandboxLaunchOptions,
  SandboxProvider,
  SandboxStatus,
} from "./provider.js";

/** Where the session repo lands inside the sandbox. */
export const SANDBOX_REPO_PATH = "/home/user/repo";

export interface E2bProviderOptions {
  /** E2B template id; the default base image when omitted. */
  template?: string;
  /** Default wall-clock lifetime; a launch's own `ttlMs` overrides it. */
  timeoutMs?: number;
}

export class E2bProvider implements SandboxProvider {
  readonly name = "e2b";

  constructor(private readonly options: E2bProviderOptions = {}) {}

  async launch(options: SandboxLaunchOptions): Promise<SandboxHandle> {
    // The credential deadline wins: E2B reclaims the microVM at `timeoutMs`
    // whether or not anything is still around to stop it.
    const timeoutMs = options.ttlMs ?? this.options.timeoutMs;
    const createOpts = {
      envs: { ...options.env },
      metadata: { sideStreetSessionId: options.sessionId },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    const sandbox =
      this.options.template !== undefined
        ? await Sandbox.create(this.options.template, createOpts)
        : await Sandbox.create(createOpts);

    try {
      await sandbox.git.clone(options.repoUrl, { path: SANDBOX_REPO_PATH });
    } catch (error) {
      // Never leak a microVM behind a failed launch.
      await sandbox.kill().catch(() => {});
      throw error;
    }

    return {
      id: sandbox.sandboxId,
      async status(): Promise<SandboxStatus> {
        // ponytail: running/stopped only — "paused" arrives with Phase 2
        // checkpointing (E2B betaPause), "starting" is invisible because
        // launch() only returns once the sandbox is up.
        return (await sandbox.isRunning()) ? "running" : "stopped";
      },
      async stop(): Promise<void> {
        await sandbox.kill();
      },
    };
  }
}
