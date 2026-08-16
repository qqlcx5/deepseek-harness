# 目标(Objective)

[English](objective.md) | 中文

跨会话目标注册表:[dsh-objective](../../packages/objective/objective) 在 [storage domain form](storage.md) 之上持有带有序成员会话账本的持久北极星记录。设计理由见 [convergence-layers Agent Note](../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md);服务契约细节归[包 README](../../packages/objective/objective/README.md) 所有。

objective 与 workspace 正交:workspace 按目录记录归属,objective 按意图记录归属,一个会话可服务多个目标。同会话执行目标属于 [`ctx.goals`](goal.md)；一个 objective 可以引用某会话的 goal，但不拥有它。

## 归属与日志镜像

归属先写 domain——domain 是权威。存活的成员会话额外收到一条 log-only 的 `objective/member` session 事件,携带目标 id、写入时的标题(展示快照)与动作。按目标,最后一个动作胜出;`foldObjectiveMembership(events)` 返回单个会话的有效归属(按首次记录排序),跳过畸形事件。单独发布的 `./invariant` companion 在畸形载荷进入日志前拒绝它。

## 服务行为

每个变更在串行写链上执行,只在持久写入成功后发布 `objective/changed`,且对重复的归属边幂等。启动时校验注册表顺序与记录表完全一致,任何分歧都立即失败。brief 是缓存的综述数据(`setBrief` 盖 `briefAt` 时间戳);它只能经消费者的被记录 inject 到达模型。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxobjectives--objectiveregistry"></a>

### `ctx.objectives` — `ObjectiveRegistry`

Objective registry (`ctx.objectives`) over the storage domain form. Startup opens the domain and validates that registry order and records agree; every mutation runs on a serialized write chain and publishes its notification only after the durable write succeeds. Membership writes the domain first; the session-log mirror is best-effort for live sessions and never rolls a committed domain write back.

```ts cordis-catalog
/**
 * Create an active objective and prepend it to the durable registry order.
 * @param request - Title and optional north-star statement.
 * @returns the created view.
 */
async create(request: CreateObjectiveRequest): Promise<ObjectiveView>

/**
 * Look up an objective by id.
 * @param id - Objective id.
 * @returns the detached view, or `undefined` when unknown.
 */
get(id: ObjectiveId): ObjectiveView | undefined

/**
 * Synchronous objective projection in durable registry order. Performs no
 * persistence reads.
 * @returns a fresh ordered array of detached views.
 */
list(): ObjectiveView[]

/**
 * List the objectives one session currently serves.
 * @param sessionId - Member session id.
 * @returns the member objectives in durable registry order.
 */
objectivesOf(sessionId: SessionId): ObjectiveView[]

/**
 * Edit title, north-star statement, and/or status. Every status
 * transition is legal (close is not terminal: reopening an objective is a
 * supported flow); an edit changes no other field.
 * @param id - Objective id.
 * @param request - At least one replacement field; `null` northStar clears it.
 * @returns the updated view.
 */
async update(id: ObjectiveId, request: UpdateObjectiveRequest): Promise<ObjectiveView>

/**
 * Record that a session serves this objective. Idempotent: an already
 * accounted id resolves without writing. The domain row commits first; a
 * live member session additionally receives a log-only `objective/member`
 * event, whose failure is logged and never rolls the domain write back. A
 * session that is neither live nor persisted is accepted the same way —
 * the domain is the membership authority, the log mirror is display data.
 * @param id - Objective id.
 * @param sessionId - The member session to record.
 * @returns the updated view.
 */
async attachSession(id: ObjectiveId, sessionId: SessionId): Promise<ObjectiveView>

/**
 * Remove a session from this objective's member account. Idempotent: an
 * unknown member resolves without writing. A live member session receives
 * the matching `objective/member` detach event under the same best-effort
 * rule as {@link attachSession}.
 * @param id - Objective id.
 * @param sessionId - The member session to remove.
 * @returns the updated view.
 */
async detachSession(id: ObjectiveId, sessionId: SessionId): Promise<ObjectiveView>

/**
 * Store the objective-level brief (the cached synthesis output: one
 * paragraph of current conclusions) and stamp `briefAt`. The brief reaches
 * a model only through a logged inject by a consumer; this method writes
 * no model-visible input.
 * @param id - Objective id.
 * @param brief - Non-empty brief text.
 * @returns the updated view.
 */
async setBrief(id: ObjectiveId, brief: string): Promise<ObjectiveView>

/**
 * Delete one objective record while retaining every member session log
 * (historic `objective/member` events stay and are harmless: their
 * objective simply no longer resolves). The durable order is updated
 * before the record deletion; a failed record write restores the prior
 * order. A crash between the two writes leaves an orphan record that the
 * next startup rejects loudly.
 * @param id - Objective to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
async delete(id: ObjectiveId): Promise<boolean>
```

Types: [SessionId](core.md)

Source: [`packages/objective/objective/src/index.ts:212`](../../packages/objective/objective/src/index.ts)

<a id="objective-events"></a>

### `objective/*` events

<a id="objectivechanged--emit"></a>

#### `objective/changed` — emit

One durable objective mutation committed.

```ts cordis-catalog
/**
 * One durable objective mutation committed.
 * @param payload.operation - which mutation committed.
 * @param payload.objective - post-mutation view; absent for a delete.
 * @mode emit
 */
'objective/changed'(payload: ObjectiveChanged): void
```

Source: [`packages/objective/objective/src/index.ts:120`](../../packages/objective/objective/src/index.ts)
<!-- END GENERATED cordis-surface -->
