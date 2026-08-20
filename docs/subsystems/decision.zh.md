# 决策(Decision)

[English](decision.md) | 中文

跨会话决策注册表:[dsh-decision](../../packages/decision/decision) 在 [storage domain form](storage.md) 之上把持久战略决策作为一等对象——问题、带证据与代价的选项卡、带理由与置信度的推荐、必填的反证段、可逆性分诊,以及"决定时预测 vs 一句话实际结果"的校准轨迹。设计理由见 [convergence-layers Agent Note](../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md);服务契约细节归[包 README](../../packages/decision/decision/README.md) 所有。

决策不属于任何会话:它是跨会话状态,可选地关联 objective;其回访轨迹比被度量的决策活得久。证据引用先采用自由文本;claim-id 回填随知识层到来。

## 生命周期与冻结预测

每个决策以 `open` 创建;草稿更新仅对 open 决策合法。`decide` 校验所选 label 必须在选项卡上,冻结 `predictedConfidence`(校准输入)并盖时间戳。`recordReview` 基于冻结预测追加一行结果记录;回访在决策删除后仍保留。

## 服务行为

所有变更在串行写链上执行,且只在持久写入成功后发布 `decision/changed`。启动时校验注册表顺序与 decisions 表完全一致,任何分歧都立即失败。

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
 * card the chosen label must name one of its options.
 * @param id - Decision id.
 * @param chosen - Chosen option label.
 * @param options - Optional override of the confidence frozen at decide time.
 * @returns the decided view.
 */
async decide(id: DecisionId, chosen: string, options: { confidence?: number } = {}): Promise<DecisionView>

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
 * Delete one decision record while retaining its review trail (calibration
 * history outlives the decision it measured). Idempotent for an unknown id.
 * @param id - Decision to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
async delete(id: DecisionId): Promise<boolean>
```

Source: [`packages/decision/decision/src/index.ts:171`](../../packages/decision/decision/src/index.ts)

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

Source: [`packages/decision/decision/src/index.ts:101`](../../packages/decision/decision/src/index.ts)
<!-- END GENERATED cordis-surface -->
