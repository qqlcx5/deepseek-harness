/**
 * Decision registry (`ctx.decisions`): durable strategic decisions as
 * first-class objects — question, option card with evidence and costs,
 * recommendation with rationale and confidence, the mandatory
 * counter-evidence section, reversibility triage, and the calibration trail
 * of decide-time predictions against one-line outcomes.
 *
 * Evidence references are free-form first; claim-id backfill arrives with
 * the knowledge layer. A decision belongs to no session: it is cross-session
 * state over the storage domain, and its review trail outlives any session
 * that discussed it.
 *
 * Agent Note:
 * - .agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md
 *
 * @module @deepseek-ai/dsh-decision
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ObjectiveId } from '@deepseek-ai/dsh-objective'
import { decisionDomainSpec } from './spec.ts'
import type { DecisionDomainState, DecisionRecord, DecisionReviewRecord } from './spec.ts'
import type {
  CreateDecisionRequest,
  DecisionChanged,
  DecisionId as DecisionIdBrand,
  DecisionOperation,
  DecisionOption,
  DecisionReview,
  DecisionView,
  Reversibility,
  UpdateDecisionRequest,
} from './types.ts'

export type {
  CreateDecisionRequest,
  DecisionChanged,
  DecisionOperation,
  DecisionOption,
  DecisionReview,
  DecisionStatus,
  DecisionView,
  Reversibility,
  UpdateDecisionRequest,
} from './types.ts'
export { decisionDomainSpec, decisionDomainState, decisionRecord, decisionReviewRecord } from './spec.ts'
export type { DecisionDomainState, DecisionRecord, DecisionReviewRecord } from './spec.ts'

/** Identifies one decision record (see `src/types.ts` for the brand rationale). */
export type DecisionId = DecisionIdBrand

/**
 * Brand a string as a {@link DecisionId}.
 * @param id - Raw decision id string.
 * @returns the same string, branded at compile time.
 */
export function DecisionId(id: string): DecisionId {
  return id as DecisionId
}

/** Stable error codes for rejected decision reads and mutations. */
export type DecisionErrorCode =
  | 'DECISION_NOT_FOUND'
  | 'DECISION_INVALID_QUESTION'
  | 'DECISION_INVALID_OPTION'
  | 'DECISION_INVALID_CONFIDENCE'
  | 'DECISION_INVALID_REVERSIBILITY'
  | 'DECISION_INVALID_UPDATE'
  | 'DECISION_INVALID_TRANSITION'
  | 'DECISION_UNKNOWN_OPTION'
  | 'DECISION_IRREVERSIBLE_CONFIRM'
  | 'DECISION_STALE_CARD'
  | 'DECISION_INVALID_OUTCOME'

/** A rejected decision read or mutation, carrying its stable code. */
export class DecisionError extends HarnessError {
  /**
   * @param message - Human-readable rejection reason.
   * @param code - Stable error code for routing.
   */
  constructor(message: string, code: DecisionErrorCode) {
    super(message, code)
    this.name = 'DecisionError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    decisions: DecisionRegistry
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One durable decision mutation committed.
     * @param payload.operation - which mutation committed.
     * @param payload.decision - post-mutation view; absent for a delete.
     * @mode emit
     */
    'decision/changed'(payload: DecisionChanged): void
  }
}

const REVERSIBILITIES: readonly Reversibility[] = ['reversible', 'costly', 'irreversible']

/** Validate a caller-visible non-empty question. */
function resolveQuestion(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DecisionError('decision question must be a non-empty string', 'DECISION_INVALID_QUESTION')
  }
  return value.trim()
}

/** Validate the option card: non-empty labels, unique within the decision. */
function resolveOptions(options: readonly DecisionOption[]): DecisionOption[] {
  const seen = new Set<string>()
  const resolved: DecisionOption[] = []
  for (const option of options) {
    if (typeof option.label !== 'string' || option.label.trim().length === 0
      || typeof option.evidence !== 'string') {
      throw new DecisionError('each option needs a non-empty label and an evidence string', 'DECISION_INVALID_OPTION')
    }
    const label = option.label.trim()
    if (seen.has(label)) {
      throw new DecisionError(`option label '${label}' repeats within one decision`, 'DECISION_INVALID_OPTION')
    }
    seen.add(label)
    resolved.push({
      label,
      evidence: option.evidence,
      ...option.cost === undefined ? {} : { cost: option.cost },
      ...option.risk === undefined ? {} : { risk: option.risk },
    })
  }
  return resolved
}

/** Validate a caller-visible confidence in [0, 1]. */
function resolveConfidence(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DecisionError('confidence must be a finite number in [0, 1]', 'DECISION_INVALID_CONFIDENCE')
  }
  return value
}

/** Validate a caller-visible reversibility. */
function resolveReversibility(value: Reversibility): Reversibility {
  if (!REVERSIBILITIES.includes(value)) {
    throw new DecisionError(`reversibility must be one of ${REVERSIBILITIES.join(', ')}`, 'DECISION_INVALID_REVERSIBILITY')
  }
  return value
}

/** Validate a caller-visible non-empty outcome line. */
function resolveOutcome(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DecisionError('review outcome must be a non-empty string', 'DECISION_INVALID_OUTCOME')
  }
  return value.trim()
}

/**
 * Decision registry (`ctx.decisions`) over the storage domain form. Startup
 * validates that registry order and the decisions table agree exactly;
 * review rows are calibration history and may outlive the decision they
 * reviewed (a deleted decision's reviews stay readable). Every mutation runs
 * on a serialized write chain and publishes `decision/changed` only after
 * the durable write succeeds.
 */
export class DecisionRegistry extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<DecisionId, DecisionRecord>
  private reviews?: KvTable<DecisionId, DecisionReviewRecord>
  private global?: DomainGlobal<DecisionDomainState>
  private state?: DecisionDomainState
  private operationTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'decisions')
  }

  /** Open the domain, validate stored state, and register close. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(decisionDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'decision.domainClose')
    this.table = domain.table('decisions')
    this.reviews = domain.table('reviews')
    this.global = domain.global
    this.state = domain.global.get()
    this.validateStoredState(this.state)
  }

  /**
   * Create an open decision and prepend it to the durable registry order.
   * @param request - The question plus optional initial card, triage, and due date.
   * @returns the created view.
   */
  async create(request: CreateDecisionRequest): Promise<DecisionView> {
    const question = resolveQuestion(request.question)
    const options = resolveOptions(request.options ?? [])
    const reversibility = resolveReversibility(request.reversibility ?? 'reversible')
    return this.enqueueOperation(async () => {
      const id = DecisionId(`decision-${randomUUID()}`)
      const now = new Date().toISOString()
      const record: DecisionRecord = {
        question,
        options,
        counterEvidence: '',
        reversibility,
        status: 'open',
        ...(request.objectiveId === undefined ? {} : { objectiveId: request.objectiveId }),
        ...(request.dueAt === undefined ? {} : { dueAt: request.dueAt }),
        createdAt: now,
        updatedAt: now,
      }
      const table = this.requireTable()
      const state = this.requireState()
      await table.put(id, record)
      try {
        await this.setState({ decisionIds: [id, ...state.decisionIds] })
      } catch (error) {
        try {
          await table.delete(id)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `decision '${id}' order write and record rollback both failed; the orphan record fails loud at the next startup`,
          )
        }
        throw error
      }
      return this.commit('create', id, record)
    })
  }

  /**
   * Look up a decision by id.
   * @param id - Decision id.
   * @returns the detached view, or `undefined` when unknown.
   */
  get(id: DecisionId): DecisionView | undefined {
    const record = this.requireTable().get(id)
    return record === undefined ? undefined : this.view(id, record)
  }

  /**
   * Synchronous decision projection in durable registry order. Performs no
   * persistence reads.
   * @returns a fresh ordered array of detached views.
   */
  list(): DecisionView[] {
    return this.requireState().decisionIds.map((id) => {
      const record = this.requireTable().get(id)
      /* v8 ignore next 2 -- startup validation and the serialized write chain keep order and table in exact agreement */
      if (record === undefined) {
        throw new Error(`decision registry order references missing decision '${id}'`)
      }
      return this.view(id, record)
    })
  }

  /**
   * The open decisions in durable registry order.
   * @returns every decision whose status is `open`.
   */
  listOpen(): DecisionView[] {
    return this.list().filter(decision => decision.status === 'open')
  }

  /**
   * Replace draft fields on an open decision: question, option card,
   * counter-evidence, recommendation, rationale, confidence, triage, and/or
   * due date. Only an open decision accepts a draft update; a decided or
   * superseded one is history.
   * @param id - Decision id.
   * @param request - At least one replacement field; `null` clears the nullable ones.
   * @returns the updated view.
   */
  async update(id: DecisionId, request: UpdateDecisionRequest): Promise<DecisionView> {
    if (request.question === undefined && request.options === undefined && request.counterEvidence === undefined
      && request.recommendation === undefined && request.rationale === undefined && request.confidence === undefined
      && request.reversibility === undefined && request.dueAt === undefined) {
      throw new DecisionError('decision update requires at least one field', 'DECISION_INVALID_UPDATE')
    }
    return this.enqueueOperation(async () => {
      const record = this.requireOpen(id)
      const next: DecisionRecord = { ...record, updatedAt: this.nextMutationTime(record) }
      if (request.question !== undefined) next.question = resolveQuestion(request.question)
      if (request.options !== undefined) next.options = resolveOptions(request.options)
      if (request.counterEvidence !== undefined) next.counterEvidence = request.counterEvidence
      if (request.recommendation !== undefined) {
        if (request.recommendation === null) delete next.recommendation
        else next.recommendation = request.recommendation
      }
      if (request.rationale !== undefined) {
        if (request.rationale === null) delete next.rationale
        else next.rationale = request.rationale
      }
      if (request.confidence !== undefined) {
        if (request.confidence === null) delete next.confidence
        else next.confidence = resolveConfidence(request.confidence)
      }
      if (request.reversibility !== undefined) next.reversibility = resolveReversibility(request.reversibility)
      if (request.dueAt !== undefined) {
        if (request.dueAt === null) delete next.dueAt
        else next.dueAt = request.dueAt
      }
      await this.requireTable().put(id, next)
      return this.commit('update', id, next)
    })
  }

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
  async decide(
    id: DecisionId,
    chosen: string,
    options: { confidence?: number; confirm?: boolean; expectedUpdatedAt?: string } = {},
  ): Promise<DecisionView> {
    if (typeof chosen !== 'string' || chosen.trim().length === 0) {
      throw new DecisionError('chosen option must be a non-empty label', 'DECISION_UNKNOWN_OPTION')
    }
    return this.enqueueOperation(async () => {
      const record = this.requireOpen(id)
      if (record.reversibility === 'irreversible' && options.confirm !== true) {
        throw new DecisionError(
          `decision '${record.question}' is irreversible; surface the counter-evidence and cited sources, then pass confirm`,
          'DECISION_IRREVERSIBLE_CONFIRM',
        )
      }
      if (options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== record.updatedAt) {
        throw new DecisionError(
          `decision '${record.question}' changed since the caller read it; re-read the card and retry`,
          'DECISION_STALE_CARD',
        )
      }
      const labels = new Set(record.options.map(option => option.label))
      if (labels.size > 0 && !labels.has(chosen)) {
        throw new DecisionError(
          `chosen option '${chosen}' is not on the card: ${[...labels].join(', ')}`,
          'DECISION_UNKNOWN_OPTION',
        )
      }
      const predicted = options.confidence === undefined ? record.confidence : resolveConfidence(options.confidence)
      const at = this.nextMutationTime(record)
      const next: DecisionRecord = {
        ...record,
        status: 'decided',
        chosen,
        decidedAt: at,
        updatedAt: at,
        ...predicted === undefined ? {} : { predictedConfidence: predicted },
      }
      await this.requireTable().put(id, next)
      return this.commit('decide', id, next)
    })
  }

  /**
   * Mark a decision superseded: kept for the trail, no longer the answer to
   * its question. Idempotent for an already-superseded decision.
   * @param id - Decision id.
   * @returns the superseded view.
   */
  async supersede(id: DecisionId): Promise<DecisionView> {
    return this.enqueueOperation(async () => {
      const record = this.requireRecord(id)
      if (record.status === 'superseded') return this.view(id, record)
      const next: DecisionRecord = {
        ...record,
        status: 'superseded',
        updatedAt: this.nextMutationTime(record),
      }
      await this.requireTable().put(id, next)
      return this.commit('supersede', id, next)
    })
  }

  /**
   * Record one calibration data point: the one-line actual outcome against
   * the decide-time prediction. Requires a decided decision; repeat reviews
   * of the same decision are allowed (the latest is the current outcome).
   * @param id - Decision id.
   * @param actualOutcome - One-line actual outcome.
   * @param options - Optional calibration note.
   * @returns the stored review.
   */
  async recordReview(id: DecisionId, actualOutcome: string, options: { calibrationNote?: string } = {}): Promise<DecisionReview> {
    const outcome = resolveOutcome(actualOutcome)
    return this.enqueueOperation(async () => {
      const record = this.requireRecord(id)
      if (record.status !== 'decided') {
        throw new DecisionError(
          `decision '${record.question}' is ${record.status}; only a decided decision accepts a review`,
          'DECISION_INVALID_TRANSITION',
        )
      }
      const review: DecisionReviewRecord = {
        id: DecisionId(`review-${randomUUID()}`),
        decisionId: id,
        ...record.objectiveId === undefined ? {} : { objectiveId: record.objectiveId },
        reviewedAt: new Date().toISOString(),
        ...record.predictedConfidence === undefined ? {} : { predictedConfidence: record.predictedConfidence },
        actualOutcome: outcome,
        ...options.calibrationNote === undefined ? {} : { calibrationNote: options.calibrationNote },
      }
      await (this.reviews as KvTable<DecisionId, DecisionReviewRecord>).put(review.id, review)
      const view = this.reviewView(review)
      this.ctx.emit('decision/changed', { operation: 'review', decision: this.view(id, record) })
      return view
    })
  }

  /**
   * The review trail of one decision, oldest first.
   * @param id - Decision id.
   * @returns every recorded review, including those of a deleted decision.
   */
  reviewsOf(id: DecisionId): DecisionReview[] {
    const reviews: DecisionReview[] = []
    const oldestFirst = (left: DecisionReviewRecord, right: DecisionReviewRecord): number =>
      left.reviewedAt.localeCompare(right.reviewedAt)
    for (const [, review] of [...(this.reviews as KvTable<DecisionId, DecisionReviewRecord>).entries()]
      .sort(([, left], [, right]) => oldestFirst(left, right))) {
      if (review.decisionId !== id) continue
      reviews.push(this.reviewView(review))
    }
    return reviews
  }

  /**
   * The calibration trail aggregated by objective: every review whose
   * decision carried this objective, oldest first, including reviews of
   * decisions that were later deleted (the review row snapshots the
   * objective at record time). Calibration reads this, not per-decision
   * queries: the unit a human calibrates is a topic, not one card.
   * @param objectiveId - The objective to aggregate under.
   * @returns every matching review, oldest first.
   */
  reviewsByObjective(objectiveId: ObjectiveId): DecisionReview[] {
    const aggregated: DecisionReview[] = []
    const reviews = this.reviews as KvTable<DecisionId, DecisionReviewRecord>
    const entries = [...reviews.entries()]
      .sort(([, left], [, right]) => left.reviewedAt.localeCompare(right.reviewedAt))
    for (const [, review] of entries) {
      if (review.objectiveId !== objectiveId) continue
      aggregated.push({
        id: review.id,
        decisionId: review.decisionId,
        objectiveId: review.objectiveId,
        reviewedAt: review.reviewedAt,
        ...review.predictedConfidence === undefined ? {} : { predictedConfidence: review.predictedConfidence },
        actualOutcome: review.actualOutcome,
        ...review.calibrationNote === undefined ? {} : { calibrationNote: review.calibrationNote },
      })
    }
    return aggregated
  }

  /**
   * Delete one decision record while retaining its review trail (calibration
   * history outlives the decision it measured). Idempotent for an unknown id.
   * @param id - Decision to remove.
   * @returns `true` when a record was deleted, `false` when it was unknown.
   */
  async delete(id: DecisionId): Promise<boolean> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.decisionIds.includes(id)) return false
      /* jscpd:ignore-start -- rollback boilerplate shared with dsh-objective; extract on a third registry */
      const nextState: DecisionDomainState = { decisionIds: state.decisionIds.filter(member => member !== id) }
      await this.setState(nextState)
      try {
        await this.requireTable().delete(id)
      } catch (error) {
        try {
          await this.setState(state)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `decision '${id}' record deletion and registry-order rollback both failed`,
          )
        }
        throw error
      }
      /* jscpd:ignore-end */
      this.ctx.emit('decision/changed', { operation: 'delete' })
      return true
    })
  }

  /** Fail loud unless registry order and the decisions table agree exactly. */
  private validateStoredState(state: DecisionDomainState): void {
    const table = this.requireTable()
    const order = new Set<string>()
    for (const id of state.decisionIds) {
      if (order.has(id)) {
        throw new Error(`decision domain is inconsistent: registry order repeats decision '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`decision domain is inconsistent: registry order references missing decision '${id}'`)
      }
      order.add(id)
    }
    /* jscpd:ignore-start -- consistency check shared with dsh-objective */
    for (const id of table.keys()) {
      if (!order.has(id)) {
        throw new Error(`decision domain is inconsistent: decision '${id}' is absent from registry order`)
      }
    }
  }

  /* jscpd:ignore-end */

  /** Build a detached review view from one stored review record. */
  private reviewView(review: DecisionReviewRecord): DecisionReview {
    return {
      id: review.id,
      decisionId: review.decisionId,
      reviewedAt: review.reviewedAt,
      ...review.predictedConfidence === undefined ? {} : { predictedConfidence: review.predictedConfidence },
      actualOutcome: review.actualOutcome,
      ...review.calibrationNote === undefined ? {} : { calibrationNote: review.calibrationNote },
    }
  }

  /** The record for a known id, or the not-found rejection. */
  private requireRecord(id: DecisionId): DecisionRecord {
    const record = this.requireTable().get(id)
    if (record === undefined) {
      throw new DecisionError(`no decision '${String(id)}'`, 'DECISION_NOT_FOUND')
    }
    return record
  }

  /** The record for a known open decision, or its rejection. */
  private requireOpen(id: DecisionId): DecisionRecord {
    const record = this.requireRecord(id)
    if (record.status !== 'open') {
      throw new DecisionError(
        `decision '${record.question}' is ${record.status}; only an open decision accepts this mutation`,
        'DECISION_INVALID_TRANSITION',
      )
    }
    return record
  }

  /** Publish the post-mutation view after its durable write succeeded. */
  private commit(operation: Exclude<DecisionOperation, 'delete' | 'review'>, id: DecisionId, record: DecisionRecord): DecisionView {
    const decision = this.view(id, record)
    this.ctx.emit('decision/changed', { operation, decision })
    return decision
  }

  /** Build a detached view from one stored record. */
  private view(id: DecisionId, record: DecisionRecord): DecisionView {
    const options: DecisionOption[] = record.options.map(option => ({
      label: option.label,
      evidence: option.evidence,
      ...option.cost === undefined ? {} : { cost: option.cost },
      ...option.risk === undefined ? {} : { risk: option.risk },
    }))
    return {
      id,
      question: record.question,
      ...record.objectiveId === undefined ? {} : { objectiveId: record.objectiveId },
      options,
      counterEvidence: record.counterEvidence,
      ...record.recommendation === undefined ? {} : { recommendation: record.recommendation },
      ...record.rationale === undefined ? {} : { rationale: record.rationale },
      ...record.confidence === undefined ? {} : { confidence: record.confidence },
      reversibility: record.reversibility,
      status: record.status,
      ...record.chosen === undefined ? {} : { chosen: record.chosen },
      ...record.predictedConfidence === undefined ? {} : { predictedConfidence: record.predictedConfidence },
      ...record.decidedAt === undefined ? {} : { decidedAt: record.decidedAt },
      ...record.dueAt === undefined ? {} : { dueAt: record.dueAt },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  /* jscpd:ignore-start -- registry plumbing shared with dsh-objective; extract on a third registry */
  /** Clamp the next mutation timestamp against backward wall-clock movement. */
  private nextMutationTime(record: DecisionRecord): string {
    const now = Date.now()
    const parsed = Date.parse(record.updatedAt)
    /* v8 ignore next 2 -- updatedAt is always a service-written ISO instant */

    if (Number.isNaN(parsed)) return new Date(now).toISOString()
    return new Date(Math.max(now, parsed)).toISOString()
  }

  private requireTable(): KvTable<DecisionId, DecisionRecord> {
    if (this.table === undefined) throw new Error('decision registry is not started yet')
    return this.table
  }

  private requireState(): DecisionDomainState {
    if (this.state === undefined) throw new Error('decision registry is not started yet')
    return this.state
  }

  private async setState(state: DecisionDomainState): Promise<void> {
    await (this.global as DomainGlobal<DecisionDomainState>).set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
  /* jscpd:ignore-end */
}

export default DecisionRegistry
