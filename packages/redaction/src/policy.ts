/**
 * Per-role redaction policy (PLAN.md §3). The redaction pass runs per outbound
 * socket, keyed by that viewer's role, so the policy decides — per role —
 * whether secrets are stripped. Invariant 5 is the hard floor: an Observer must
 * never see raw secrets, so no shipped policy may return false for "observer".
 */

import type { Role, SignedEvent } from "@side-street/core";
import { BUILTIN_PATTERNS, type SecretPattern } from "./patterns.js";
import { redactEvent } from "./redact.js";

export interface RedactionPolicy {
  /** Whether events sent to this role have secrets redacted. */
  redactsFor(role: Role): boolean;
}

/** Redact for every role — secrets reach no viewer. The safe default. */
export const redactAll: RedactionPolicy = { redactsFor: (): boolean => true };

/**
 * Redact for everyone except the authoritative Driver — who already approves
 * the side-effecting tool calls that surface these secrets. Still satisfies the
 * Observer floor. Opt in explicitly; the default stays `redactAll`.
 */
export const redactExceptDriver: RedactionPolicy = {
  redactsFor: (role): boolean => role !== "driver",
};

export interface RedactionConfig {
  /** Defaults to `redactAll`. */
  policy?: RedactionPolicy;
  /** Exact secret values known to the session (injected credentials). */
  knownSecrets?: readonly string[];
  /** Overrides the built-in secret patterns. */
  patterns?: readonly SecretPattern[];
}

/**
 * Redact an event for delivery to a viewer of the given role. Returns the event
 * unchanged when the policy exempts the role; otherwise runs the redaction pass.
 */
export function redactEventForRole(
  event: SignedEvent,
  role: Role,
  config: RedactionConfig = {},
): SignedEvent {
  const policy = config.policy ?? redactAll;
  if (!policy.redactsFor(role)) {
    return event;
  }
  return redactEvent(event, config.knownSecrets, config.patterns ?? BUILTIN_PATTERNS);
}
