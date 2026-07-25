# ADR-0003: AGPL-3.0 licensing with CLA-backed dual licensing

- **Status:** Accepted
- **Date:** 2026-07-25
- **Deciders:** project founder

## Decision drivers

The founder's constraints: the project must be genuinely open source, but protected against
third parties commercializing it for free — specifically the cloud-reseller play where a
provider offers hosted Side Street as a closed service.

## Context

Apache-2.0 (the initial choice) permits exactly that reseller play. The established options:

- **AGPL-3.0** — OSI-approved open source; its network-copyleft clause (§13) requires anyone
  offering the software as a network service to release their modifications' source. This is
  the license Grafana, MinIO, and Mastodon chose for the same reason.
- **BSL / Elastic-style source-available** — stronger commercial protection but **not open
  source** by the OSI definition; would contradict the project's positioning and community
  strategy.
- **Apache-2.0 + open-core** — maximum adoption, no resale protection on the core.

## Decision

License everything in this repository under **AGPL-3.0-only**. Require a **Contributor
License Agreement** so the project retains the right to dual-license — the hosted control
plane, SSO/SCIM, and managed compliance features can be offered commercially without
relicensing anyone else's work. State this boundary publicly from day one (PLAN.md Phase 4).

## Consequences

- Closed commercial resale is off the table: any competitor hosting Side Street must publish
  their modifications, neutralizing the free-rider risk while keeping self-hosting free for
  everyone.
- Some enterprises have blanket AGPL bans; that friction is acceptable — they are exactly the
  audience for the future commercial license, which the CLA keeps available to us.
- SDK-style client libraries that teams embed in their own apps may later warrant a more
  permissive license (MIT/Apache) per-package; that carve-out needs its own ADR when it
  arises.
- The CLA adds first-PR friction for contributors; we accept it as the price of a sustainable
  dual-license model and will use a low-friction bot (e.g. cla-assistant).
