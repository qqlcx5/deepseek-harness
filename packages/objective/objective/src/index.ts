/**
 * Cross-session objective registry (`ctx.objectives`): durable north-star
 * records with an ordered member account of sessions over the domain data
 * form. Membership is written to the domain and, for a live member session,
 * mirrored as a log-only `objective/member` session event so one session's
 * log alone recovers its objective affiliations. The objective title in that
 * event is a display snapshot; the domain record owns the authoritative
 * value.
 *
 * The registry is orthogonal to workspace membership: a session may serve
 * several objectives and an objective may span directories. Same-session
 * execution goals belong to `ctx.goals`; an objective may reference a
 * session's goal without owning it.
 *
 * Agent Note:
 * - .agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md
 *
 * @module @deepseek-ai/dsh-objective
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { z as zod } from 'zod'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { objectiveDomainSpec } from './spec.ts'
import type { ObjectiveDomainState, ObjectiveRecord } from './spec.ts'
import type {
  CreateObjectiveRequest,
  ObjectiveChanged,
  ObjectiveId as ObjectiveIdBrand,
  ObjectiveOperation,
  ObjectiveStatus,
  ObjectiveView,
  UpdateObjectiveRequest,
} from './types.ts'

export type {
  CreateObjectiveRequest,
  ObjectiveChanged,
  ObjectiveOperation,
  ObjectiveStatus,
  ObjectiveView,
  UpdateObjectiveRequest,
} from './types.ts'
export { objectiveDomainSpec, objectiveDomainState, objectiveRecord } from './spec.ts'
export type { ObjectiveDomainState, ObjectiveRecord } from './spec.ts'

/** Identifies one objective record (see `src/types.ts` for the brand rationale). */
export type ObjectiveId = ObjectiveIdBrand

/**
 * Brand a string as an {@link ObjectiveId}.
 * @param id - Raw objective id string.
 * @returns the same string, branded at compile time.
 */
export function ObjectiveId(id: string): ObjectiveId {
  return id as ObjectiveId
}

/** Stable error codes for rejected objective reads and mutations. */
export type ObjectiveErrorCode =
  | 'OBJECTIVE_NOT_FOUND'
  | 'OBJECTIVE_INVALID_TITLE'
  | 'OBJECTIVE_INVALID_NORTH_STAR'
  | 'OBJECTIVE_INVALID_STATUS'
  | 'OBJECTIVE_INVALID_BRIEF'
  | 'OBJECTIVE_INVALID_UPDATE'

/** A rejected objective read or mutation, carrying its stable code. */
export class ObjectiveError extends HarnessError {
  /**
   * @param message - Human-readable rejection reason.
   * @param code - Stable error code for routing.
   */
  constructor(message: string, code: ObjectiveErrorCode) {
    super(message, code)
    this.name = 'ObjectiveError'
  }
}

/** Payload of the log-only `objective/member` session event. */
export interface ObjectiveMemberMeta {
  /** Payload vocabulary version. */
  readonly version: 1
  /** The objective the member session entered or left. */
  readonly objectiveId: ObjectiveId
  /** Objective title at write time; a display snapshot, not the authority. */
  readonly title: string
  /** Which membership edge was recorded. */
  readonly action: 'attach' | 'detach'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Cross-session objective membership edge recorded on the member session:
     * log-only, non-surface, per-objective last action wins. Fold with
     * {@link foldObjectiveMembership}.
     */
    'objective/member': ObjectiveMemberMeta
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    objectives: ObjectiveRegistry
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One durable objective mutation committed.
     * @param payload.operation - which mutation committed.
     * @param payload.objective - post-mutation view; absent for a delete.
     * @mode emit
     */
    'objective/changed'(payload: ObjectiveChanged): void
  }
}

const OBJECTIVE_STATUSES: readonly ObjectiveStatus[] = ['active', 'parked', 'closed']

/** Wire schema of the `objective/member` event payload. */
const objectiveMemberSchema = zod.object({
  version: zod.literal(1),
  objectiveId: zod.string().min(1),
  title: zod.string().min(1),
  action: zod.enum(['attach', 'detach']),
})

/**
 * Validate one raw `objective/member` payload.
 * @param value - Raw event data from a session log.
 * @returns the detached membership meta, or `undefined` when malformed.
 */
export function validateObjectiveMember(value: unknown): ObjectiveMemberMeta | undefined {
  const result = objectiveMemberSchema.safeParse(value)
  if (!result.success) return undefined
  return {
    version: 1,
    objectiveId: result.data.objectiveId as ObjectiveId,
    title: result.data.title,
    action: result.data.action,
  }
}

/**
 * Fold the objective affiliations of one session log: per objective, the
 * last `objective/member` action wins, so a detach cancels an earlier attach
 * and a later attach restores it. Malformed events are skipped, matching the
 * projection posture (the `./invariant` companion rejects them fail-loud
 * where it is installed).
 * @param events - The session log or any prefix of it.
 * @returns the effective memberships in first-record order.
 */
export function foldObjectiveMembership(events: readonly SessionEvent[]): readonly ObjectiveMemberMeta[] {
  const attached = new Map<string, ObjectiveMemberMeta>()
  for (const event of events) {
    if (event.type !== 'objective/member') continue
    const meta = validateObjectiveMember(event.data)
    /* v8 ignore next 2 -- projection posture: malformed events skip */
    if (meta === undefined) continue
    if (meta.action === 'detach') attached.delete(meta.objectiveId)
    else attached.set(meta.objectiveId, meta)
  }
  return [...attached.values()]
}

/** Validate a caller-visible non-empty title. */
function resolveTitle(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ObjectiveError('objective title must be a non-empty string', 'OBJECTIVE_INVALID_TITLE')
  }
  return value.trim()
}

/** Validate a caller-visible non-empty north-star statement. */
function resolveNorthStar(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ObjectiveError('objective northStar must be a non-empty string', 'OBJECTIVE_INVALID_NORTH_STAR')
  }
  return value.trim()
}

/** Validate a caller-visible non-empty brief. */
function resolveBrief(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ObjectiveError('objective brief must be a non-empty string', 'OBJECTIVE_INVALID_BRIEF')
  }
  return value.trim()
}

/** Validate a caller-visible lifecycle status. */
function resolveStatus(value: ObjectiveStatus): ObjectiveStatus {
  if (!OBJECTIVE_STATUSES.includes(value)) {
    throw new ObjectiveError(`objective status must be one of ${OBJECTIVE_STATUSES.join(', ')}`, 'OBJECTIVE_INVALID_STATUS')
  }
  return value
}

/**
 * Objective registry (`ctx.objectives`) over the storage domain form.
 * Startup opens the domain and validates that registry order and records
 * agree; every mutation runs on a serialized write chain and publishes its
 * notification only after the durable write succeeds. Membership writes the
 * domain first; the session-log mirror is best-effort for live sessions and
 * never rolls a committed domain write back.
 */
export class ObjectiveRegistry extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<ObjectiveId, ObjectiveRecord>
  private global?: DomainGlobal<ObjectiveDomainState>
  private state?: ObjectiveDomainState
  private operationTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'objectives')
  }

  /** Open the domain, validate stored state, and register close. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(objectiveDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'objective.domainClose')
    this.table = domain.table('objectives')
    this.global = domain.global
    this.state = domain.global.get()
    this.validateStoredState(this.state)
  }

  /**
   * Create an active objective and prepend it to the durable registry order.
   * @param request - Title and optional north-star statement.
   * @returns the created view.
   */
  async create(request: CreateObjectiveRequest): Promise<ObjectiveView> {
    const title = resolveTitle(request.title)
    const northStar = request.northStar === undefined ? undefined : resolveNorthStar(request.northStar)
    return this.enqueueOperation(async () => {
      const id = ObjectiveId(`objective-${randomUUID()}`)
      const now = new Date().toISOString()
      const record: ObjectiveRecord = {
        title,
        status: 'active',
        ...(northStar === undefined ? {} : { northStar }),
        sessionIds: [],
        createdAt: now,
        updatedAt: now,
      }
      const table = this.requireTable()
      const state = this.requireState()
      await table.put(id, record)
      try {
        await this.setState({ objectiveIds: [id, ...state.objectiveIds] })
      } catch (error) {
        try {
          await table.delete(id)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `objective '${id}' order write and record rollback both failed; the orphan record fails loud at the next startup`,
          )
        }
        throw error
      }
      return this.commit('create', id, record)
    })
  }

  /**
   * Look up an objective by id.
   * @param id - Objective id.
   * @returns the detached view, or `undefined` when unknown.
   */
  get(id: ObjectiveId): ObjectiveView | undefined {
    const record = this.requireTable().get(id)
    return record === undefined ? undefined : this.view(id, record)
  }

  /**
   * Synchronous objective projection in durable registry order. Performs no
   * persistence reads.
   * @returns a fresh ordered array of detached views.
   */
  list(): ObjectiveView[] {
    return this.requireState().objectiveIds.map((id) => {
      const record = this.requireTable().get(id)
      /* v8 ignore next 2 -- startup validation and the serialized write chain keep order and table in exact agreement */
      if (record === undefined) {
        throw new Error(`objective registry order references missing objective '${id}'`)
      }
      return this.view(id, record)
    })
  }

  /**
   * List the objectives one session currently serves.
   * @param sessionId - Member session id.
   * @returns the member objectives in durable registry order.
   */
  objectivesOf(sessionId: SessionId): ObjectiveView[] {
    return this.list().filter(objective => objective.sessionIds.includes(sessionId))
  }

  /**
   * Edit title, north-star statement, and/or status. Every status
   * transition is legal (close is not terminal: reopening an objective is a
   * supported flow); an edit changes no other field.
   * @param id - Objective id.
   * @param request - At least one replacement field; `null` northStar clears it.
   * @returns the updated view.
   */
  async update(id: ObjectiveId, request: UpdateObjectiveRequest): Promise<ObjectiveView> {
    if (request.title === undefined && request.northStar === undefined && request.status === undefined) {
      throw new ObjectiveError('objective update requires title, northStar, and/or status', 'OBJECTIVE_INVALID_UPDATE')
    }
    const title = request.title === undefined ? undefined : resolveTitle(request.title)
    const northStar = request.northStar === undefined ? undefined
      : request.northStar === null ? null
        : resolveNorthStar(request.northStar)
    const status = request.status === undefined ? undefined : resolveStatus(request.status)
    return this.enqueueOperation(async () => {
      const record = this.requireRecord(id)
      const next: ObjectiveRecord = { ...record, updatedAt: this.nextMutationTime(record) }
      if (title !== undefined) next.title = title
      if (northStar !== undefined) {
        if (northStar === null) delete next.northStar
        else next.northStar = northStar
      }
      if (status !== undefined) next.status = status
      await this.requireTable().put(id, next)
      return this.commit('update', id, next)
    })
  }

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
  async attachSession(id: ObjectiveId, sessionId: SessionId): Promise<ObjectiveView> {
    return this.enqueueOperation(async () => {
      const record = this.requireRecord(id)
      if (record.sessionIds.includes(sessionId)) return this.view(id, record)
      const next: ObjectiveRecord = {
        ...record,
        sessionIds: [sessionId, ...record.sessionIds],
        updatedAt: this.nextMutationTime(record),
      }
      await this.requireTable().put(id, next)
      this.mirrorMembership(sessionId, { version: 1, objectiveId: id, title: next.title, action: 'attach' })
      return this.commit('attach', id, next)
    })
  }

  /**
   * Remove a session from this objective's member account. Idempotent: an
   * unknown member resolves without writing. A live member session receives
   * the matching `objective/member` detach event under the same best-effort
   * rule as {@link attachSession}.
   * @param id - Objective id.
   * @param sessionId - The member session to remove.
   * @returns the updated view.
   */
  async detachSession(id: ObjectiveId, sessionId: SessionId): Promise<ObjectiveView> {
    return this.enqueueOperation(async () => {
      const record = this.requireRecord(id)
      if (!record.sessionIds.includes(sessionId)) return this.view(id, record)
      const next: ObjectiveRecord = {
        ...record,
        sessionIds: record.sessionIds.filter(member => member !== sessionId),
        updatedAt: this.nextMutationTime(record),
      }
      await this.requireTable().put(id, next)
      this.mirrorMembership(sessionId, { version: 1, objectiveId: id, title: next.title, action: 'detach' })
      return this.commit('detach', id, next)
    })
  }

  /**
   * Store the objective-level brief (the cached synthesis output: one
   * paragraph of current conclusions) and stamp `briefAt`. The brief reaches
   * a model only through a logged inject by a consumer; this method writes
   * no model-visible input.
   * @param id - Objective id.
   * @param brief - Non-empty brief text.
   * @returns the updated view.
   */
  async setBrief(id: ObjectiveId, brief: string): Promise<ObjectiveView> {
    const text = resolveBrief(brief)
    return this.enqueueOperation(async () => {
      const record = this.requireRecord(id)
      const at = this.nextMutationTime(record)
      const next: ObjectiveRecord = { ...record, brief: text, briefAt: at, updatedAt: at }
      await this.requireTable().put(id, next)
      return this.commit('brief', id, next)
    })
  }

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
  async delete(id: ObjectiveId): Promise<boolean> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.objectiveIds.includes(id)) return false
      const nextState: ObjectiveDomainState = { objectiveIds: state.objectiveIds.filter(member => member !== id) }
      await this.setState(nextState)
      try {
        await this.requireTable().delete(id)
      } catch (error) {
        try {
          await this.setState(state)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `objective '${id}' record deletion and registry-order rollback both failed`,
          )
        }
        throw error
      }
      this.ctx.emit('objective/changed', { operation: 'delete' })
      return true
    })
  }

  /** Fail loud unless registry order and the record table agree exactly. */
  private validateStoredState(state: ObjectiveDomainState): void {
    const table = this.requireTable()
    const order = new Set<string>()
    for (const id of state.objectiveIds) {
      if (order.has(id)) {
        throw new Error(`objective domain is inconsistent: registry order repeats objective '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`objective domain is inconsistent: registry order references missing objective '${id}'`)
      }
      order.add(id)
    }
    for (const id of table.keys()) {
      if (!order.has(id)) {
        throw new Error(`objective domain is inconsistent: objective '${id}' is absent from registry order`)
      }
    }
  }

  /** Append the log-only mirror event for a live member session, best-effort. */
  private mirrorMembership(sessionId: SessionId, meta: ObjectiveMemberMeta): void {
    const session = this.ctx.get('sessions')?.get(sessionId)
    if (session === undefined) return
    try {
      session.append('objective/member', meta)
    } catch (error) {
      this.ctx.logger.warn(
        `objective '${meta.objectiveId}' membership for session '${sessionId}' was recorded in the domain but not in the session log: %o`,
        error,
      )
    }
  }

  /** Publish the post-mutation view after its durable write succeeded. */
  private commit(operation: Exclude<ObjectiveOperation, 'delete'>, id: ObjectiveId, record: ObjectiveRecord): ObjectiveView {
    const objective = this.view(id, record)
    this.ctx.emit('objective/changed', { operation, objective })
    return objective
  }

  /** Build a detached view from one stored record. */
  private view(id: ObjectiveId, record: ObjectiveRecord): ObjectiveView {
    return {
      id,
      title: record.title,
      ...(record.northStar === undefined ? {} : { northStar: record.northStar }),
      status: record.status,
      ...(record.brief === undefined ? {} : { brief: record.brief }),
      ...(record.briefAt === undefined ? {} : { briefAt: record.briefAt }),
      sessionIds: [...record.sessionIds],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  /** The record for a known id, or the not-found rejection. */
  private requireRecord(id: ObjectiveId): ObjectiveRecord {
    const record = this.requireTable().get(id)
    if (record === undefined) {
      throw new ObjectiveError(`no objective '${id}'`, 'OBJECTIVE_NOT_FOUND')
    }
    return record
  }

  /** Clamp the next mutation timestamp against backward wall-clock movement. */
  private nextMutationTime(record: ObjectiveRecord): string {
    const now = Date.now()
    const parsed = Date.parse(record.updatedAt)
    /* v8 ignore next 2 -- every record's updatedAt is written by this service as a
     * valid ISO instant, so the NaN arm is unreachable defense */
    if (Number.isNaN(parsed)) return new Date(now).toISOString()
    return new Date(Math.max(now, parsed)).toISOString()
  }

  private requireTable(): KvTable<ObjectiveId, ObjectiveRecord> {
    if (this.table === undefined) throw new Error('objective registry is not started yet')
    return this.table
  }

  private requireState(): ObjectiveDomainState {
    if (this.state === undefined) throw new Error('objective registry is not started yet')
    return this.state
  }

  private async setState(state: ObjectiveDomainState): Promise<void> {
    await (this.global as DomainGlobal<ObjectiveDomainState>).set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

export default ObjectiveRegistry
