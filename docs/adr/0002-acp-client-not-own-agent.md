# ADR-0002: Wrap existing agents via ACP; never build our own agent

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** project founder

## Context

The product needs coding intelligence, and the labs (Anthropic, OpenAI, Google) out-model any
independent harness every quarter. The Agent Client Protocol (ACP) standardizes how coding
agents plug into client environments — `session/prompt`, streamed `session/update`
notifications, fire-and-forget `session/cancel`, and a first-class
`session/request_permission` handshake — with Claude Code, Gemini CLI, Codex (via
`codex-acp`), and Copilot CLI in the live registry.

## Decision

Side Street is an **ACP client**, not an agent. The session actor drives whatever backing
agent the team chooses over ACP inside the session sandbox; MCP is consumed for tools; A2A is
ignored for now. Steering maps onto the industry-consensus mechanism: queued messages drain
at tool-call boundaries; hard-interrupt is `session/cancel` followed by an immediate
re-prompt carrying the queued human messages; side-effecting tools gate on
`request_permission` surfaced to the Driver.

`packages/acp-client` must stay behind an interface: if ACP adoption stalls or fragments, a
direct-harness adapter (e.g. Claude Agent SDK) slots in behind the same interface (PLAN.md
§8).

## Consequences

- Agent-agnosticism becomes a real, demonstrable product property — the Phase 3 benchmark
  requires the same session to run on two different backing agents.
- We inherit ACP's granularity limits: there is no standard mid-turn steering injection, so
  "steer now" is cancel-then-reprompt at turn boundaries until the protocol grows one. Our
  UX must be honest about that boundary.
- We take a dependency on external agent release cycles and their ACP conformance quality;
  version pinning and conformance tests per supported agent are required.
- We permanently forgo differentiating on model quality — the moat must come from the
  collaboration surface, steering model, and audit layer (PLAN.md §2).
