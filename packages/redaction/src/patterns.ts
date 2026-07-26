/**
 * High-signal secret patterns (PLAN.md §3, invariant 5). These catch secrets
 * the agent surfaces that we did NOT inject — e.g. it prints a token found in
 * a repo file. Session-injected credentials are caught more precisely by exact
 * known-literal matching (see `redactString`), so these lean toward low false
 * positives over exhaustiveness: a missed exotic key is a bug to add a pattern
 * for; a redacted tool-call id is a broken session.
 */

/** A named secret shape. `regex` must be global; `render` builds the replacement. */
export interface SecretPattern {
  readonly label: string;
  readonly regex: RegExp;
  /** Replacement for a whole match; defaults to a bare `[redacted:<label>]`. */
  readonly render?: (match: string) => string;
}

export function placeholder(label: string): string {
  return `[redacted:${label}]`;
}

/** Keep the assignment's key/separator, redact only the value. */
function redactAssignmentValue(label: string): (match: string) => string {
  return (match) => {
    const sep = match.search(/[=:]/);
    // No separator should be impossible (the regex requires one), but never
    // emit the raw value if it somehow is — redact the whole match.
    return sep < 0 ? placeholder(label) : `${match.slice(0, sep + 1)}${placeholder(label)}`;
  };
}

export const BUILTIN_PATTERNS: readonly SecretPattern[] = [
  {
    label: "private-key",
    regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  },
  { label: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "gcp-api-key", regex: /\bAIza[0-9A-Za-z_-]{35,}\b/g },
  { label: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "api-key", regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  {
    label: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    label: "bearer-token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
    render: () => `Bearer ${placeholder("bearer-token")}`,
  },
  {
    // KEY=..., API_TOKEN: ..., DB_PASSWORD="..." — the catch-all for named
    // secrets. Value is a quoted string or a run of non-space characters.
    // Same-line only ([ \t], not \s): a bare `KEY:` with content on the next
    // line is not an assignment, and must not swallow the following line.
    label: "env-secret",
    regex:
      /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PASSPHRASE)[A-Za-z0-9_]*[ \t]*[=:][ \t]*(?:"[^"]*"|'[^']*'|\S+)/gi,
    render: redactAssignmentValue("env-secret"),
  },
];
