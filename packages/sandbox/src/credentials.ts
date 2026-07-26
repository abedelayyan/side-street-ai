/**
 * Session-scoped credentials (PLAN.md Phase 2, invariant 4). A credential
 * reaches the agent exactly one way — the boot environment of that session's
 * sandbox. It never enters a prompt and never enters the event log, and it
 * outlives neither the grant nor the sandbox holding it.
 *
 * Expiry is enforced twice on purpose: the launcher tears the sandbox down at
 * the deadline, and the provider gets the same deadline so the sandbox still
 * dies if the launcher process does.
 */

import type { SandboxHandle, SandboxProvider } from "./provider.js";

export interface CredentialRequest {
  sessionId: string;
  /** Grant lifetime; the sandbox never outlives it. */
  ttlMs: number;
}

export interface CredentialGrant {
  /** Injected as the sandbox's boot environment. Every value is a secret. */
  readonly env: Readonly<Record<string, string>>;
  /** Epoch ms after which the credential must not be usable. */
  readonly expiresAt: number;
  /** Invalidate upstream. Idempotent; safe to call after expiry. */
  revoke(): Promise<void>;
}

export interface CredentialIssuer {
  readonly name: string;
  issue(request: CredentialRequest): Promise<CredentialGrant>;
}

/**
 * Dev and self-host issuer: scopes values the operator already holds to one
 * session's sandbox and one deadline.
 *
 * ponytail: the values are long-lived upstream, so `revoke()` has nothing to
 * call — expiry is only as strong as killing the sandbox that holds them. A
 * minting issuer (GitHub App installation token, AWS STS) drops in behind this
 * interface and makes expiry real at the source; that is the production path.
 */
export function staticCredentialIssuer(
  env: Readonly<Record<string, string>>,
  name = "static",
): CredentialIssuer {
  const scoped = Object.freeze({ ...env });
  return {
    name,
    issue({ ttlMs }: CredentialRequest): Promise<CredentialGrant> {
      return Promise.resolve({
        env: scoped,
        expiresAt: Date.now() + ttlMs,
        revoke: (): Promise<void> => Promise.resolve(),
      });
    },
  };
}

/** One hour: long enough for a debugging session, short enough to matter. */
export const DEFAULT_CREDENTIAL_TTL_MS = 60 * 60 * 1000;

export interface SessionSandboxOptions {
  provider: SandboxProvider;
  issuer: CredentialIssuer;
  sessionId: string;
  repoUrl: string;
  /** Grant and sandbox lifetime. Defaults to `DEFAULT_CREDENTIAL_TTL_MS`. */
  ttlMs?: number;
  /** Non-secret boot environment. The grant wins on key collisions. */
  env?: Readonly<Record<string, string>>;
  /** Called once the deadline has torn the sandbox down. */
  onExpired?: () => void;
}

export interface SessionSandbox {
  readonly handle: SandboxHandle;
  readonly expiresAt: number;
  /**
   * The grant's secret values, for the redaction pass's `knownSecrets`. Never
   * put these in an event, a prompt, or a log line.
   */
  readonly secrets: readonly string[];
  /** Stop the sandbox and revoke the grant. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Issue a session's credentials, boot its sandbox with them, and arm expiry.
 */
export async function launchSessionSandbox(
  options: SessionSandboxOptions,
): Promise<SessionSandbox> {
  const ttlMs = options.ttlMs ?? DEFAULT_CREDENTIAL_TTL_MS;
  const grant = await options.issuer.issue({ sessionId: options.sessionId, ttlMs });
  const remainingMs = Math.max(0, grant.expiresAt - Date.now());

  let handle: SandboxHandle;
  try {
    handle = await options.provider.launch({
      sessionId: options.sessionId,
      repoUrl: options.repoUrl,
      env: { ...options.env, ...grant.env },
      ttlMs: remainingMs,
    });
  } catch (error) {
    // Never leave a live grant behind a sandbox that never booted.
    await grant.revoke();
    throw error;
  }

  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(timer);
    // Kill the holder first: a grant nothing can revoke upstream still stops
    // being reachable once its sandbox is gone.
    try {
      await handle.stop();
    } finally {
      await grant.revoke();
    }
  };

  timer = setTimeout(() => {
    void stop().then(
      () => options.onExpired?.(),
      // Expiry is best-effort here; the provider holds the same deadline.
      () => options.onExpired?.(),
    );
  }, remainingMs);

  return {
    handle,
    expiresAt: grant.expiresAt,
    secrets: Object.values(grant.env),
    stop,
  };
}
