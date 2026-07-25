# Side Street

**The open-source multiplayer layer for coding agents.**

Anyone on your team can drop into the same live agent session — watch it work token-by-token,
steer it, hand it off, and audit exactly who told the agent what. Side Street doesn't ship its
own agent: it wraps Claude Code, Codex, Gemini CLI, and anything else that speaks the
[Agent Client Protocol](https://agentclientprotocol.com), and owns the collaboration surface
around them.

> **Status: pre-alpha.** We're building in public against a phased plan — see
> [`docs/PLAN.md`](docs/PLAN.md). Nothing is runnable yet; the foundation is being laid.

## Why

- Agents now run tasks that take hours, days, even weeks — but every session is trapped on one person's laptop.
- Every shipping coding agent solved *single-user* steering the same way (queue input, inject at the next tool-call boundary, hard-interrupt escape hatch). **Nobody has shipped multiple humans steering one agent.** That's what we're building.
- The moments teams already crowd around one problem — incident response, on-call debugging, senior-steers-junior mentoring — deserve better than screen-share and copy-paste.

## What it will look like

- **Shared durable sessions** — one Cloudflare Durable Object per session with an append-only event log; sessions survive laptops, reconnects, and days of wall-clock time. Late joiners replay from an offset and land in the live stream.
- **Multi-human steering** — Driver / Navigator / Observer roles, an attributed intervention queue drained at tool-call boundaries, explicit hard-interrupt, and "take the wheel" handoff.
- **Tamper-evident attribution** — every steering action, approval, and interrupt is signed into a hash-chained log. Who steered what is legible and can't be quietly rewritten.
- **A security envelope** — per-role secret redaction before anything reaches a viewer, session-scoped short-lived credentials, sandboxed execution, and human approval gates on side-effecting tools.
- **Agent-agnostic by design** — the backing agent and the sandbox are swappable interfaces, never vendor lock-in.

## Documentation

| Doc | What it is |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | The project plan — phases, architecture decisions, benchmarks. The source of truth. |
| [`docs/research/`](docs/research/) | The research foundation the plan is built on. |
| [`CLAUDE.md`](CLAUDE.md) | The working agreement all contributors (human and agent) follow. |

## License

[Apache-2.0](LICENSE).
