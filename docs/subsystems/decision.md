# Decisions

English | [中文](decision.zh.md)

Cross-session decision registry: [dsh-decision](../../packages/decision/decision) owns durable strategic decisions as first-class objects over the [storage domain form](storage.md) — the question, the option card with evidence and costs, the recommendation with its rationale and confidence, the mandatory counter-evidence section, reversibility triage, and the calibration trail of decide-time predictions against one-line outcomes. The [convergence-layers Agent Note](../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) owns the design rationale; the [package README](../../packages/decision/decision/README.md) owns the service contract detail.

A decision belongs to no session: it is cross-session state, optionally linked to an objective, and its review trail outlives the decision it measured. Evidence references are free-form first; claim-id backfill arrives with the knowledge layer.

## Lifecycle and the frozen prediction

Every decision starts `open`; draft updates are legal only while open. `decide` validates the chosen label against the option card, freezes `predictedConfidence` (the calibration input), and stamps the instant. `recordReview` appends one outcome row against that frozen prediction; reviews survive deletion of the decision.

## Service behavior

Mutations run on a serialized write chain and publish `decision/changed` only after the durable write succeeds. Startup validates that registry order and the decisions table agree exactly and fails loud on divergence.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdecisions--decisionregistry"></a>

### `ctx.decisions` — `DecisionRegistry`

Decision registry (`ctx.decisions`) over the storage domain form. Startup validates that registry order and the decisions table agree exactly; review rows are calibration history and may outlive the decision they reviewed (a deleted decision's reviews stay readable). Every mutation runs on a serialized write chain and publishes `decision/changed` only after the durable write succeeds.

```ts cordis-catalog
/**
 * Create an open decision and prepend it to the durable registry order.
 * @param request - The question plus optional initial card, triage, and due date.
 * @returns the created view.
 */
async create(request: CreateDecisionRequest): Promise<DecisionView>

/**
 * Look up a decision by id.
 * @param id - Decision id.
 * @returns the detached view, or `undefined` when unknown.
 */
get(id: DecisionId): DecisionView | undefined

/**
 * Synchronous decision projection in durable registry order. Performs no
 * persistence reads.
 * @returns a fresh ordered array of detached views.
 */
list(): DecisionView[]

/**
 * The open decisions in durable registry order.
 * @returns every decision whose status is `open`.
 */
listOpen(): DecisionView[]

/**
 * Replace draft fields on an open decision: question, option card,
 * counter-evidence, recommendation, rationale, confidence, triage, and/or
 * due date. Only an open decision accepts a draft update; a decided or
 * superseded one is history.
 * @param id - Decision id.
 * @param request - At least one replacement field; `null` clears the nullable ones.
 * @returns the updated view.
 */
async update(id: DecisionId, request: UpdateDecisionRequest): Promise<DecisionView>

/**
 * Make the decision: choose one option, freeze the confidence snapshot the
 * calibration trail reads, and stamp the instant. With a non-empty option
 * card the chosen label must name one of its options. An irreversible
 * decision requires an explicit confirmation pass (`confirm: true`): the
 * first attempt rejects with `DECISION_IRREVERSIBLE_CONFIRM` so the caller
 * surfaces the counter-evidence and cited sources before the second pass.
 * An `expectedUpdatedAt` fence rejects with `DECISION_STALE_CARD` when the
 * card changed since the caller read it — approving a card the human never
 * saw must be impossible.
 * @param id - Decision id.
 * @param chosen - Chosen option label.
 * @param options - Optional confidence override, irreversible confirmation, and the card stamp the caller read.
 * @returns the decided view.
 */
async decide( id: DecisionId, chosen: string, options: { confidence?: number; confirm?: boolean; expectedUpdatedAt?: string } = {}, ): Promise<DecisionView>

/**
 * Mark a decision superseded: kept for the trail, no longer the answer to
 * its question. Idempotent for an already-superseded decision.
 * @param id - Decision id.
 * @returns the superseded view.
 */
async supersede(id: DecisionId): Promise<DecisionView>

/**
 * Record one calibration data point: the one-line actual outcome against
 * the decide-time prediction. Requires a decided decision; repeat reviews
 * of the same decision are allowed (the latest is the current outcome).
 * @param id - Decision id.
 * @param actualOutcome - One-line actual outcome.
 * @param options - Optional calibration note.
 * @returns the stored review.
 */
async recordReview(id: DecisionId, actualOutcome: string, options: { calibrationNote?: string } = {}): Promise<DecisionReview>

/**
 * The review trail of one decision, oldest first.
 * @param id - Decision id.
 * @returns every recorded review, including those of a deleted decision.
 */
reviewsOf(id: DecisionId): DecisionReview[]

/**
 * The calibration trail aggregated by objective: every review whose
 * decision carried this objective, oldest first, including reviews of
 * decisions that were later deleted (the review row snapshots the
 * objective at record time). Calibration reads this, not per-decision
 * queries: the unit a human calibrates is a topic, not one card.
 * @param objectiveId - The objective to aggregate under.
 * @returns every matching review, oldest first.
 */
reviewsByObjective(objectiveId: ObjectiveId): DecisionReview[]

/**
 * Delete one decision record while retaining its review trail (calibration
 * history outlives the decision it measured). Idempotent for an unknown id.
 * @param id - Decision to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
async delete(id: DecisionId): Promise<boolean>
```

Types: [ObjectiveId](objective.md)

Source: [`packages/decision/decision/src/index.ts:174`](../../packages/decision/decision/src/index.ts)

<a id="decision-events"></a>

### `decision/*` events

<a id="decisionchanged--emit"></a>

#### `decision/changed` — emit

One durable decision mutation committed.

```ts cordis-catalog
/**
 * One durable decision mutation committed.
 * @param payload.operation - which mutation committed.
 * @param payload.decision - post-mutation view; absent for a delete.
 * @mode emit
 */
'decision/changed'(payload: DecisionChanged): void
```

Source: [`packages/decision/decision/src/index.ts:104`](../../packages/decision/decision/src/index.ts)
<!-- END GENERATED cordis-surface -->
