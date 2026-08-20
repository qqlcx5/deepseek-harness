/**
 * The knowledge domain declaration: record schemas and the `defineDomain`
 * spec the registry opens. The zod schemas are the durable-boundary
 * validators.
 * @module @deepseek-ai/dsh-knowledge/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ClaimId } from './types.ts'
import type { ObjectiveId } from '@deepseek-ai/dsh-objective'

/** Claim id schema at the durable boundary; branding has no runtime representation. */
const claimId = z.string().transform(value => value as ClaimId)

/** Objective reference at the durable boundary; an opaque cross-domain id. */
const objectiveRef = z.string().transform(value => value as ObjectiveId)

/** Confidence: a number in [0, 1]. */
const confidence = z.number().min(0).max(1)

/** Where a claim's proposition came from. */
const sourceKind = z.enum(['session', 'artifact', 'memory', 'external'])

/**
 * Durable shape of one claim record. Supersession and conflict are edges,
 * not statuses; `validUntil` is a re-validation date, not an expiry delete.
 */
export const claimRecord = z.object({
  proposition: z.string().min(1),
  sourceKind,
  sourceUri: z.string().min(1),
  sourceSession: z.string().min(1).optional(),
  sourceAnchor: z.string().min(1).optional(),
  confidence: confidence.optional(),
  validUntil: z.string().min(1).optional(),
  status: z.enum(['active', 'retired', 'promoted']),
  objectiveId: objectiveRef.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

/** One stored claim record, inferred from {@link claimRecord}. */
export type ClaimRecord = z.infer<typeof claimRecord>

/** Durable shape of one edge record: one relation per ordered claim pair. */
export const claimEdgeRecord = z.object({
  src: claimId,
  dst: claimId,
  relation: z.enum(['supports', 'refines', 'supersedes', 'contradicts']),
})

/** One stored edge record. */
export type ClaimEdgeRecord = z.infer<typeof claimEdgeRecord>

/** Edge table key: the ordered pair, `src->dst`. */
export function claimEdgeKey(src: ClaimId, dst: ClaimId): string {
  return `${String(src)}->${String(dst)}`
}

/**
 * Durable registry state; `claimIds` is the authoritative display order.
 * Edges are their own table keyed by pair and are not order-tracked.
 */
export const claimDomainState = z.object({
  claimIds: z.array(claimId),
})

/** Durable registry state inferred from {@link claimDomainState}. */
export type ClaimDomainState = z.infer<typeof claimDomainState>

/**
 * The knowledge domain spec: one `claims` table keyed by {@link ClaimId},
 * one `claimEdges` table keyed by the ordered pair, plus the order
 * singleton. The registry opens this through `ctx.storage.domain`.
 */
export const claimDomainSpec = defineDomain({
  name: 'knowledge',
  version: 1,
  global: {
    schema: claimDomainState,
    initial: { claimIds: [] },
  },
  tables: {
    claims: domainTable<ClaimId, ClaimRecord>(claimRecord),
    claimEdges: domainTable<string, ClaimEdgeRecord>(claimEdgeRecord),
  },
})
