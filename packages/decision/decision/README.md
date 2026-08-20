# @deepseek-ai/dsh-decision

English | [中文](README.zh.md)

Cross-session strategic decision registry. The service owns durable decisions as first-class objects — the question, the option card with evidence and costs, the recommendation with its rationale and confidence, the mandatory counter-evidence section, reversibility triage — plus the calibration trail of decide-time predictions against one-line outcomes. The [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) owns the design rationale.

Evidence references are free-form first; claim-id backfill arrives with the knowledge layer. A decision belongs to no session: it is cross-session state over the [storage domain form](../../storage/storage-domain/README.md), optionally linked to an objective, and its review trail outlives both the decision and any session that discussed it.

## Service contract

`ctx.decisions` exposes create, get, list, listOpen, update, decide, supersede, recordReview, reviewsOf, and delete. Mutations run on a serialized write chain and publish `decision/changed` only after the durable write succeeds. Startup validates that registry order and the decisions table agree exactly and fails loud on divergence.

Every decision starts `open` with an empty counter-evidence section; draft updates (question, options, counter-evidence, recommendation, rationale, confidence, reversibility, due date) are legal only while open — a decided or superseded decision is history. `decide` validates the chosen label against the option card when one exists, freezes `predictedConfidence` (the explicit override, else the drafted confidence), and stamps `decidedAt`. An irreversible decision requires `confirm: true` — the first pass rejects with `DECISION_IRREVERSIBLE_CONFIRM` so the caller quotes the current counter-evidence before the second; an `expectedUpdatedAt` fence rejects with `DECISION_STALE_CARD` when the card changed since the caller read it, so approving a card the human never saw is impossible. `recordReview` appends one calibration row against that frozen prediction, snapshots the decision's objective onto the row, and survives the deletion of the decision it measured. `reviewsByObjective` aggregates the trail per objective, oldest first — calibration reads a topic, not one card; reviews of unlinked decisions match no aggregate. Option labels are unique and non-empty within one decision; confidence is a finite number in [0, 1].

The counter-evidence field is mandatory as a field: empty is allowed, absent is not — the surface that sets the agenda must also carry what it knows against it. Enforcement lives at the durable boundary (the domain schema has no absent form) and in the consumer surfaces that render the card.

## Extension points

Consumers react to `decision/changed` after durable commits. A drafter consumer fills the card through `update` and never writes `decided` — deciding is a human interaction, not an automatic write. A review surface reads `reviewsOf` for the calibration trail. The separately published `./invariant` companion registers nothing at runtime.

## Model Experience

None, as this package registers no model-visible input: decisions are cross-session domain data, and nothing here enters prompt, tool schema, or session event. A consumer that surfaces a decision card to a model owns its own model experience.

#### KV Cache effect

The package contributes no model request content, so an existing request prefix stays reusable.

## Known Limitations and Deferred Work

- **No automatic review delivery** — `dueAt` is a durable field and due decisions surface through list views; riding the schedule seam needs a session anchor a cross-session decision does not have yet. The command surface lists due-unreviewed decisions instead.
- **Calibration is storage only** — the long-horizon calibration report (per the Agent Note, reported after at least 100 reviews) has no consumer yet; `reviewsOf` and `reviewsByObjective` are the raw trail.
- **Reviews are unrestricted** — nothing rate-limits `recordReview`; a runaway consumer can append duplicate outcome rows and pollute the trail (dedupe on read is not implemented).
- **The irreversible gate is procedural, not cognitive** — `confirm: true` proves a second pass happened, not that the human read the counter-evidence; the semantic check stays with the rendering surface and the sampling audit.
- **No claim linkage** — evidence is free-form text by design until the knowledge layer lands; the backfill converts references to claim ids without changing this registry.
- **Reviews outlive decisions** — deleting a decision keeps its review rows by design (calibration history); a listing that must join them filters by `decisionId` against absent records.
