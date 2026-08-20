# @deepseek-ai/dsh-knowledge

English | [中文](README.zh.md)

Cross-session claim registry: atomic propositions with provenance and the edge graph over them — `supports`, `refines`, `supersedes`, `contradicts`. Supersession and conflict are edges, not statuses: a superseded claim stays readable with its full trail. Promotion requires corroboration from distinct evidence sources at canonical document granularity, so parallel audits sharing one upstream artifact never count twice. The [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) owns the design rationale.

## Service contract

`ctx.claims` exposes create, get, list, listActive, link, edgesOf, promote, retire, and delete. Provenance is mandatory at create (a known `sourceKind` plus a non-empty `sourceUri`); confidence is a finite number in [0, 1]; `validUntil` is a re-validation date, not an expiry delete. Mutations run on a serialized write chain and publish `claim/changed` only after the durable write succeeds. Startup validates that registry order and the claims table agree exactly.

`link` writes one relation per ordered pair — re-linking a pair replaces its relation — and rejects self-edges and unknown ends. Edges survive the deletion of the claims they mention: an edge naming an absent claim is inert data, not corruption. `canonicalDocumentUri` strips fragments and line anchors, and `promote` reduces the claim's own source plus the supplied corroborating locations to document roots: fewer than two distinct roots rejects with `CLAIM_INVALID_CORROBORATION`. A promoted claim is immutable (retire demotes); only an active claim promotes.

## Extension points

Consumers react to `claim/changed` after durable commits. A sentinel consumer classifies a new claim against the bounded comparison set (same-objective, promoted, decision-cited) into `contradicts` (alarm with both sources), `refines` (a conditional difference — an edge, no alarm), or no conflict; adjudication writes edges through `link`. An extractor consumer creates claims with provenance resolving to session log records. The separately published `./invariant` companion registers nothing at runtime.

## Model Experience

None, as this package registers no model-visible input: claims are cross-session domain data, and nothing here enters prompt, tool schema, or session event. A consumer that surfaces claims to a model owns its own model experience.

#### KV Cache effect

The package contributes no model request content, so an existing request prefix stays reusable.

## Known Limitations and Deferred Work

- **No decision linkage yet** — decision evidence fields are still free-form; the backfill that converts references to claim ids (and marks decisions for re-review when a cited claim is superseded) lands with the sentinel consumer.
- **Atomicity is the extractor's job** — the registry stores propositions verbatim; judging that a proposition is atomic and dedup-worthy is a consumer concern (two phrasings of one fact are two claims until a consumer links them).
- **Edges are order-silent** — the edge table is keyed by pair and not order-tracked; listing order is insertion order of the underlying unit.
- **Promotion destination is abstract** — `promoted` is a durable status; exporting to a deployment memory surface awaits a concrete memory consumer.
