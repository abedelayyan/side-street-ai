# Side Street

**The open-source multiplayer layer for coding agents.**

Anyone on your team can drop into the same live agent session — watch it work token-by-token,
steer it, hand it off, and audit exactly who told the agent what. Side Street doesn't ship its
own agent: it wraps Claude Code, Codex, Gemini CLI, and anything else that speaks the
[Agent Client Protocol](https://agentclientprotocol.com), and owns the collaboration surface
around them.

> **Status: pre-alpha, but runnable.** We're building in public against a phased plan — see
> [`docs/PLAN.md`](docs/PLAN.md).
>
> **What works today (local dev):** two humans in separate browsers co-steer one live agent
> session against a real coding agent over ACP — shared durable timeline, Driver/Navigator/Observer
> roles, mid-turn steering, hard-interrupt, and "take the wheel" handoff. The session runs on a
> Cloudflare Durable Object (SQLite event log + hibernating WebSockets) with offset-based
> late-joiner replay, and a per-session E2B microVM adapter behind the swappable sandbox interface.
>
> **Landed from the safety layer (Phase 2):** an append-only, hash-chained event log with a
> server-side verification endpoint; per-role secret **redaction** before every broadcast
> (Observers never see raw secrets); and **Driver-only approval gates** on side-effecting tools —
> the agent blocks until the Driver approves.
>
> **Not yet:** authentication (v0 identity is unauthenticated query params — do not expose beyond
> dev), session-scoped credential injection, checkpoint compaction, side-effect compensation, and
> the red-team prompt-injection suite. Not production-ready.

## Why

- Agents now run tasks that take hours, days, even weeks — but every session is trapped on one person's laptop.
- Every shipping coding agent solved _single-user_ steering the same way (queue input, inject at the next tool-call boundary, hard-interrupt escape hatch). **Nobody has shipped multiple humans steering one agent.** That's what we're building.
- The moments teams already crowd around one problem — incident response, on-call debugging, senior-steers-junior mentoring — deserve better than screen-share and copy-paste.

## What it will look like

- **Shared durable sessions** — one Cloudflare Durable Object per session with an append-only event log; sessions survive laptops, reconnects, and days of wall-clock time. Late joiners replay from an offset and land in the live stream.
- **Multi-human steering** — Driver / Navigator / Observer roles, an attributed intervention queue drained at tool-call boundaries, explicit hard-interrupt, and "take the wheel" handoff.
- **Tamper-evident attribution** — every steering action, approval, and interrupt is signed into a hash-chained log. Who steered what is legible and can't be quietly rewritten.
- **A security envelope** — per-role secret redaction before anything reaches a viewer, session-scoped short-lived credentials, sandboxed execution, and human approval gates on side-effecting tools.
- **Agent-agnostic by design** — the backing agent and the sandbox are swappable interfaces, never vendor lock-in.

## Documentation

| Doc                                | What it is                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| [`docs/PLAN.md`](docs/PLAN.md)     | The project plan — phases, architecture decisions, benchmarks. The source of truth. |
| [`docs/research/`](docs/research/) | The research foundation the plan is built on.                                       |
| [`CLAUDE.md`](CLAUDE.md)           | The working agreement all contributors (human and agent) follow.                    |

## License

[AGPL-3.0](LICENSE). Side Street is and will remain open source: you can use it, self-host it,
and modify it freely. The AGPL's network copyleft means anyone offering Side Street as a
service must open-source their modifications — which keeps closed commercial resale off the
table while keeping the project genuinely open. Commercial licensing for the hosted control
plane is described in [`docs/PLAN.md`](docs/PLAN.md).
