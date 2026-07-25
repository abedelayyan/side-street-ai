# Security Policy

Side Street's whole premise is putting a privileged, credential-holding agent in front of
multiple viewers — security reports are product feedback of the highest order and we treat
them that way.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security tab → "Report a vulnerability").

Include what you can: affected component (session actor, redaction pipeline, steering
queue, sandbox adapter…), reproduction steps, and impact (e.g. "Observer can see an
unredacted secret", "Navigator can bypass Driver authority", "event log tamper is not
detected").

## What to expect

- Acknowledgement within **72 hours**.
- A fix or mitigation plan within **14 days** for issues that break an architecture
  invariant (attribution integrity, redaction, role authority, sandbox isolation).
- Credit in the release notes and advisory unless you prefer otherwise.

## Scope notes

- Prompt-injection paths that cause secret exfiltration or unauthorized side effects are
  **in scope** — our red-team suite exists to catch these, and new bypasses are exactly what
  we want to hear about.
- Vulnerabilities in the backing agents themselves (Claude Code, Codex, …) should go to
  their vendors, but envelope failures — our layer failing to contain such an agent — are in
  scope here.
