/**
 * Knowledge registry (`ctx.claims`): atomic propositions with provenance and
 * the edge graph over them — supports, refines, supersedes, contradicts.
 * Supersession and conflict are edges, not statuses: a superseded claim
 * stays readable with its full trail. Promotion requires corroboration from
 * distinct evidence sources at canonical document granularity, so parallel
 * audits sharing one upstream artifact never count twice.
 *
 * Agent Note:
 * - .agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md
 *
 * @module @deepseek-ai/dsh-knowledge
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { claimDomainSpec, claimEdgeKey } from './spec.ts'
import type { ClaimDomainState, ClaimEdgeRecord, ClaimRecord } from './spec.ts'
import type {
  ClaimChanged,
  ClaimEdge,
  ClaimEdgeRelation,
  ClaimId as ClaimIdBrand,
  ClaimOperation,
  ClaimSourceKind,
  ClaimView,
  CreateClaimRequest,
} from './types.ts'

export type {
  ClaimChanged,
  ClaimEdge,
  ClaimEdgeRelation,
  ClaimOperation,
  ClaimSourceKind,
  ClaimStatus,
  ClaimView,
  CreateClaimRequest,
} from './types.ts'
export { claimDomainSpec, claimDomainState, claimEdgeKey, claimRecord, claimEdgeRecord } from './spec.ts'
export type { ClaimDomainState, ClaimRecord, ClaimEdgeRecord } from './spec.ts'

/** Identifies one claim record (see `src/types.ts` for the brand rationale). */
export type ClaimId = ClaimIdBrand

/**
 * Brand a string as a {@link ClaimId}.
 * @param id - Raw claim id string.
 * @returns the same string, branded at compile time.
 */
export function ClaimId(id: string): ClaimId {
  return id as ClaimId
}

/** Stable error codes for rejected claim reads and mutations. */
export type ClaimErrorCode =
  | 'CLAIM_NOT_FOUND'
  | 'CLAIM_INVALID_PROPOSITION'
  | 'CLAIM_INVALID_SOURCE'
  | 'CLAIM_INVALID_CONFIDENCE'
  | 'CLAIM_INVALID_CORROBORATION'
  | 'CLAIM_SELF_EDGE'
  | 'CLAIM_INVALID_PROMOTION'
  | 'CLAIM_PROMOTED_IMMUTABLE'

/** A rejected claim read or mutation, carrying its stable code. */
export class ClaimError extends HarnessError {
  /**
   * @param message - Human-readable rejection reason.
   * @param code - Stable error code for routing.
   */
  constructor(message: string, code: ClaimErrorCode) {
    super(message, code)
    this.name = 'ClaimError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    claims: ClaimRegistry
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One durable claim mutation committed.
     * @param payload.operation - which mutation committed.
     * @param payload.claim - post-mutation view; absent for a delete.
     * @mode emit
     */
    'claim/changed'(payload: ClaimChanged): void
  }
}

const SOURCE_KINDS: readonly ClaimSourceKind[] = ['session', 'artifact', 'memory', 'external']
const EDGE_RELATIONS: readonly ClaimEdgeRelation[] = ['supports', 'refines', 'supersedes', 'contradicts']

/** Validate a caller-visible non-empty proposition. */
function resolveProposition(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ClaimError('claim proposition must be a non-empty string', 'CLAIM_INVALID_PROPOSITION')
  }
  return value.trim()
}

/** Validate the provenance pair: a known kind and a non-empty location. */
function resolveSource(kind: ClaimSourceKind, uri: string): { sourceKind: ClaimSourceKind; sourceUri: string } {
  if (!SOURCE_KINDS.includes(kind)) {
    throw new ClaimError(`sourceKind must be one of ${SOURCE_KINDS.join(', ')}`, 'CLAIM_INVALID_SOURCE')
  }
  if (typeof uri !== 'string' || uri.trim().length === 0) {
    throw new ClaimError('sourceUri must be a non-empty string', 'CLAIM_INVALID_SOURCE')
  }
  return { sourceKind: kind, sourceUri: uri.trim() }
}

/** Validate a caller-visible confidence in [0, 1]. */
function resolveConfidence(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ClaimError('confidence must be a finite number in [0, 1]', 'CLAIM_INVALID_CONFIDENCE')
  }
  return value
}

/** Validate an edge relation. */
function resolveRelation(value: ClaimEdgeRelation): ClaimEdgeRelation {
  if (!EDGE_RELATIONS.includes(value)) {
    throw new ClaimError(`relation must be one of ${EDGE_RELATIONS.join(', ')}`, 'CLAIM_INVALID_PROPOSITION')
  }
  return value
}

/**
 * The canonical document root of a source location: the fragment (and any
 * line anchor after `:L`) is stripped, so two anchors inside one artifact
 * reduce to one source. Evidence distinctness is judged on these roots.
 * @param uri - Raw source location.
 * @returns the canonical document root.
 */
export function canonicalDocumentUri(uri: string): string {
  const withoutFragment = uri.split('#', 1)[0] as string
  return withoutFragment.replace(/:L\d+$/u, '')
}

/**
 * Claim registry (`ctx.claims`) over the storage domain form. Startup
 * validates that registry order and the claims table agree exactly; edge
 * rows survive the deletion of the claims they mention (an edge naming an
 * absent claim is inert data, not corruption). Every mutation runs on a
 * serialized write chain and publishes `claim/changed` only after the
 * durable write succeeds.
 */
export class ClaimRegistry extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<ClaimId, ClaimRecord>
  private edges?: KvTable<string, ClaimEdgeRecord>
  private global?: DomainGlobal<ClaimDomainState>
  private state?: ClaimDomainState
  private operationTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'claims')
  }

  /** Open the domain, validate stored state, and register close. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(claimDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'knowledge.domainClose')
    this.table = domain.table('claims')
    this.edges = domain.table('edges')
    this.global = domain.global
    this.state = domain.global.get()
    this.validateStoredState(this.state)
  }

  /**
   * Create an active claim with mandatory provenance and prepend it to the
   * durable registry order.
   * @param request - The proposition, its source, and optional context.
   * @returns the created view.
   */
  async create(request: CreateClaimRequest): Promise<ClaimView> {
    const proposition = resolveProposition(request.proposition)
    const source = resolveSource(request.sourceKind, request.sourceUri)
    const confidence = request.confidence === undefined ? undefined : resolveConfidence(request.confidence)
    return this.enqueueOperation(async () => {
      const id = ClaimId(`claim-${randomUUID()}`)
      const now = new Date().toISOString()
      const record: ClaimRecord = {
        proposition,
        ...source,
        status: 'active',
        ...(request.sourceSession === undefined ? {} : { sourceSession: request.sourceSession }),
        ...(request.sourceAnchor === undefined ? {} : { sourceAnchor: request.sourceAnchor }),
        ...(confidence === undefined ? {} : { confidence }),
        ...(request.validUntil === undefined ? {} : { validUntil: request.validUntil }),
        ...(request.objectiveId === undefined ? {} : { objectiveId: request.objectiveId }),
        createdAt: now,
        updatedAt: now,
      }
      const table = this.requireTable()
      const state = this.requireState()
      await table.put(id, record)
      try {
        await this.setState({ claimIds: [id, ...state.claimIds] })
      } catch (error) {
        try {
          await table.delete(id)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `claim '${id}' order write and record rollback both failed; the orphan record fails loud at the next startup`,
          )
        }
        throw error
      }
      return this.commit('create', id, record)
    })
  }

  /**
   * Look up a claim by id.
   * @param id - Claim id.
   * @returns the detached view, or `undefined` when unknown.
   */
  get(id: ClaimId): ClaimView | undefined {
    const record = this.requireTable().get(id)
    return record === undefined ? undefined : this.view(id, record)
  }

  /**
   * Synchronous claim projection in durable registry order. Performs no
   * persistence reads.
   * @returns a fresh ordered array of detached views.
   */
  list(): ClaimView[] {
    return this.requireState().claimIds.map((id) => {
      const record = this.requireTable().get(id)
      /* v8 ignore next 2 -- startup validation and the serialized write chain keep order and table in exact agreement */
      if (record === undefined) {
        throw new Error(`claim registry order references missing claim '${id}'`)
      }
      return this.view(id, record)
    })
  }

  /**
   * The active (non-retired, non-promoted) claims in registry order.
   * @returns every claim whose status is `active`.
   */
  listActive(): ClaimView[] {
    return this.list().filter(claim => claim.status === 'active')
  }

  /**
   * Link two claims with one relation. The ordered pair carries at most one
   * relation: re-linking the same pair replaces it. Both claims must exist;
   * a self-edge rejects.
   * @param src - Source claim of the relation.
   * @param dst - Destination claim of the relation.
   * @param relation - The relation from src to dst.
   */
  async link(src: ClaimId, dst: ClaimId, relation: ClaimEdgeRelation): Promise<void> {
    const rel = resolveRelation(relation)
    return this.enqueueOperation(async () => {
      const source = this.requireRecord(src)
      this.requireRecord(dst)
      if (src === dst) {
        throw new ClaimError('a claim cannot relate to itself', 'CLAIM_SELF_EDGE')
      }
      await (this.edges as KvTable<string, ClaimEdgeRecord>)
        .put(claimEdgeKey(src, dst), { src, dst, relation: rel })
      this.ctx.emit('claim/changed', { operation: 'link', claim: this.view(src, source) })
    })
  }

  /**
   * Every edge touching one claim, in registry order: outgoing and incoming.
   * @param id - Claim id.
   * @returns the edges whose src or dst is the claim.
   */
  edgesOf(id: ClaimId): ClaimEdge[] {
    const touching: ClaimEdge[] = []
    for (const [, edge] of (this.edges as KvTable<string, ClaimEdgeRecord>).entries()) {
      if (edge.src !== id && edge.dst !== id) continue
      touching.push({ src: edge.src, dst: edge.dst, relation: edge.relation })
    }
    return touching
  }

  /**
   * Promote a claim to persistent knowledge. Corroboration is judged at
   * canonical document granularity: the claim's own source plus the supplied
   * corroborating locations must reduce to at least two distinct document
   * roots — parallel audits sharing one upstream artifact never count twice.
   * Only an active claim promotes; a promoted claim is immutable (demotion
   * is a retire).
   * @param id - Claim id.
   * @param corroboratedBy - Corroborating source locations.
   * @returns the promoted view.
   */
  async promote(id: ClaimId, corroboratedBy: readonly string[]): Promise<ClaimView> {
    const supplied = corroboratedBy as readonly unknown[]
    if (!Array.isArray(supplied) || supplied.some(uri => typeof uri !== 'string' || uri.trim().length === 0)) {
      throw new ClaimError('corroboratedBy must be non-empty source strings', 'CLAIM_INVALID_CORROBORATION')
    }
    return this.enqueueOperation(async () => {
      const record = this.requireRecord(id)
      if (record.status === 'promoted') {
        throw new ClaimError(`claim '${String(id)}' is already promoted; retire it to demote`, 'CLAIM_PROMOTED_IMMUTABLE')
      }
      if (record.status !== 'active') {
        throw new ClaimError(`claim '${String(id)}' is ${record.status}; only an active claim promotes`, 'CLAIM_INVALID_PROMOTION')
      }
      const documents = new Set([canonicalDocumentUri(record.sourceUri)])
      for (const uri of corroboratedBy) {
        documents.add(canonicalDocumentUri(uri))
      }
      if (documents.size < 2) {
        throw new ClaimError(
          `corroboration reduces to ${String(documents.size)} distinct document; promotion needs at least two`,
          'CLAIM_INVALID_CORROBORATION',
        )
      }
      const next: ClaimRecord = { ...record, status: 'promoted', updatedAt: this.nextMutationTime(record) }
      await this.requireTable().put(id, next)
      return this.commit('promote', id, next)
    })
  }

  /**
   * Retire a claim: it stays readable with its trail but leaves the active
   * set. Idempotent for an already-retired claim.
   * @param id - Claim id.
   * @returns the retired view.
   */
  async retire(id: ClaimId): Promise<ClaimView> {
    return this.enqueueOperation(async () => {
      const record = this.requireRecord(id)
      if (record.status === 'retired') return this.view(id, record)
      const next: ClaimRecord = { ...record, status: 'retired', updatedAt: this.nextMutationTime(record) }
      await this.requireTable().put(id, next)
      return this.commit('retire', id, next)
    })
  }

  /**
   * Delete one claim record while retaining every edge mentioning it (an
   * edge naming an absent claim is inert). Idempotent for an unknown id.
   * @param id - Claim to remove.
   * @returns `true` when a record was deleted, `false` when it was unknown.
   */
  async delete(id: ClaimId): Promise<boolean> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.claimIds.includes(id)) return false
      /* jscpd:ignore-start -- rollback boilerplate shared with dsh-decision; extract on a third registry */
      const nextState: ClaimDomainState = { claimIds: state.claimIds.filter(member => member !== id) }
      await this.setState(nextState)
      try {
        await this.requireTable().delete(id)
      } catch (error) {
        try {
          await this.setState(state)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `claim '${String(id)}' record deletion and registry-order rollback both failed`,
          )
        }
        throw error
      }
      /* jscpd:ignore-end */
      this.ctx.emit('claim/changed', { operation: 'delete' })
      return true
    })
  }

  /** Fail loud unless registry order and the claims table agree exactly. */
  private validateStoredState(state: ClaimDomainState): void {
    const table = this.requireTable()
    const order = new Set<string>()
    for (const id of state.claimIds) {
      if (order.has(id)) {
        throw new Error(`knowledge domain is inconsistent: registry order repeats claim '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`knowledge domain is inconsistent: registry order references missing claim '${id}'`)
      }
      order.add(id)
    }
    /* jscpd:ignore-start -- consistency check shared with dsh-decision */
    for (const id of table.keys()) {
      if (!order.has(id)) {
        throw new Error(`knowledge domain is inconsistent: claim '${id}' is absent from registry order`)
      }
    }
  }

  /* jscpd:ignore-end */

  /** The record for a known id, or the not-found rejection. */
  private requireRecord(id: ClaimId): ClaimRecord {
    const record = this.requireTable().get(id)
    if (record === undefined) {
      throw new ClaimError(`no claim '${String(id)}'`, 'CLAIM_NOT_FOUND')
    }
    return record
  }

  /** Publish the post-mutation view after its durable write succeeded. */
  private commit(operation: Exclude<ClaimOperation, 'delete' | 'link'>, id: ClaimId, record: ClaimRecord): ClaimView {
    const claim = this.view(id, record)
    this.ctx.emit('claim/changed', { operation, claim })
    return claim
  }

  /** Build a detached view from one stored record. */
  private view(id: ClaimId, record: ClaimRecord): ClaimView {
    return {
      id,
      proposition: record.proposition,
      sourceKind: record.sourceKind,
      sourceUri: record.sourceUri,
      ...record.sourceSession === undefined ? {} : { sourceSession: record.sourceSession },
      ...record.sourceAnchor === undefined ? {} : { sourceAnchor: record.sourceAnchor },
      ...record.confidence === undefined ? {} : { confidence: record.confidence },
      ...record.validUntil === undefined ? {} : { validUntil: record.validUntil },
      status: record.status,
      ...record.objectiveId === undefined ? {} : { objectiveId: record.objectiveId },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  /* jscpd:ignore-start -- registry plumbing shared with dsh-decision; extract on a third registry */
  /** Clamp the next mutation timestamp against backward wall-clock movement. */
  private nextMutationTime(record: ClaimRecord): string {
    const now = Date.now()
    const parsed = Date.parse(record.updatedAt)
    /* v8 ignore next 2 -- every record's updatedAt is written by this service as a valid ISO instant */
    if (Number.isNaN(parsed)) return new Date(now).toISOString()
    return new Date(Math.max(now, parsed)).toISOString()
  }

  private requireTable(): KvTable<ClaimId, ClaimRecord> {
    if (this.table === undefined) throw new Error('claim registry is not started yet')
    return this.table
  }

  private requireState(): ClaimDomainState {
    if (this.state === undefined) throw new Error('claim registry is not started yet')
    return this.state
  }

  private async setState(state: ClaimDomainState): Promise<void> {
    await (this.global as DomainGlobal<ClaimDomainState>).set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

/* jscpd:ignore-end */

export default ClaimRegistry
