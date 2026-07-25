# Contributing to Side Street

Thanks for your interest! Side Street is early — the highest-value contributions right now are
issues, design feedback on the steering model, and PRs against the current phase of
[`docs/PLAN.md`](docs/PLAN.md).

## Ground rules

- **The plan governs.** Every PR should advance a deliverable in `docs/PLAN.md` (the PR
  template asks which one). If your idea isn't in the plan, open an issue proposing a plan
  amendment first — that's a feature, not friction: it's how we stay coherent.
- **Working agreement.** [`CLAUDE.md`](CLAUDE.md) documents the conventions all contributors
  — human and AI — follow: trunk-based branches, Conventional Commits, small PRs, tests with
  every change, TypeScript strict, no secrets in the repo ever.
- **Architecture invariants** (append-only hash-chained log, single-Driver authority,
  redaction-before-broadcast, compensation over rollback, swappable providers) are
  non-negotiable without an ADR in `docs/adr/`.

## Getting started

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

All four must pass before you open a PR (CI enforces them).

## Pull request flow

1. Fork / branch from `main`: `feat/…`, `fix/…`, `docs/…`, `chore/…`
2. Make your change with tests.
3. `pnpm format && pnpm lint && pnpm build && pnpm test`
4. Open a PR using the template; keep it under ~400 lines of diff where possible.
5. One approving review + green CI → squash-merge.

## Licensing of contributions

Side Street is licensed under AGPL-3.0. To keep a sustainable open-source project (including
the ability to offer a commercially licensed hosted service), we ask contributors to agree to
a Contributor License Agreement (CLA) before their first PR is merged. The CLA bot will
prompt you on your first PR; the code you contribute remains open source under AGPL-3.0
forever.

## Reporting security issues

Please do **not** open public issues for vulnerabilities — see [`SECURITY.md`](SECURITY.md).

## Code of conduct

Be excellent to each other: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) applies in all project
spaces.
