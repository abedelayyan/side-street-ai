/**
 * Sandbox provider abstraction (PLAN.md §3): providers are swappable, never
 * hard-coded. A provider boots an isolated environment per session with the
 * repo cloned and session-scoped credentials injected at boot — credentials
 * never travel through prompts or the event log.
 *
 * Adapters planned: E2B (isolation-strict default) and Cloudflare Sandbox
 * (tightest DO integration). Both require accounts and land with the
 * deployment wiring.
 */

export interface SandboxLaunchOptions {
  sessionId: string;
  /** Git URL the sandbox clones before the agent starts. */
  repoUrl: string;
  /** Environment injected at boot; never logged, never prompted. */
  env: Readonly<Record<string, string>>;
}

export type SandboxStatus = "starting" | "running" | "paused" | "stopped";

export interface SandboxHandle {
  id: string;
  status(): Promise<SandboxStatus>;
  /** Graceful stop; idempotent. */
  stop(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;
  launch(options: SandboxLaunchOptions): Promise<SandboxHandle>;
}
