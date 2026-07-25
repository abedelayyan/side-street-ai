# ADR-0001: Cloudflare Durable Objects as the session spine

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** project founder

## Context

A Side Street session must survive hours to weeks, hold consistent state across restarts,
accept mid-run human intervention, and fan out a token stream to N viewers with late-joiner
replay. Candidates evaluated in the research report
(`docs/research/2026-07-multiplayer-ai-foundation.md`): Cloudflare Durable Objects, Temporal,
Inngest/Trigger.dev, Restate, DBOS, and LangGraph persistence.

## Decision

One **Cloudflare Durable Object per session** is the authoritative session actor. It owns the
append-only SQLite event log (`events(seq, ts, author_id, type, payload, prev_hash, hash)`),
the participant roster with roles, and the WebSocket connections (Hibernation API so idle
sessions cost ~nothing). Late joiners replay checkpoint + tail from a `seq` offset served
straight from SQLite — no Redis. The DO does **not** run the model; it drives an external
agent in a per-session sandbox over ACP (ADR-0002). Heavy work never happens inside the DO:
per-message work is append + redact + broadcast.

Temporal-class orchestration is deliberately deferred: if cross-service durable workflows are
needed later (e.g. compensating a failed deploy), we add Inngest or Restate as a second layer
rather than replacing the session actor.

## Consequences

- Single-threaded per-session actor gives us ordering for free — the event log's single
  writer is the platform's concurrency model, which is exactly the fit we want.
- We accept Cloudflare lock-in for the session layer; the agreed escape hatch (PLAN.md §8) is
  that if DO/sandbox costs dominate unit economics, agent execution moves to cheaper compute
  while **only the session actor** stays on Cloudflare — the actor's interface must stay
  narrow enough to keep that swap possible.
- A very hot session (hundreds of chatty participants) can queue on the single thread;
  mitigation is keeping per-message work minimal, and batching outbound token chunks.
- Local development requires DO emulation (`wrangler dev` / Miniflare) — Phase 4's
  one-command dev story must cover this.
