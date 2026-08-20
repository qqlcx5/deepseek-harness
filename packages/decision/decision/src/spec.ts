/**
 * The decision domain declaration: record schemas and the `defineDomain`
 * spec the registry opens. The zod schemas are the durable-boundary
 * validators.
 * @module @deepseek-ai/dsh-decision/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DecisionId } from './types.ts'
import type { ObjectiveId } from '@deepseek-ai/dsh-objective'

/** Decision id schema at the durable boundary; branding has no runtime representation. */
const decisionId = z.string().transform(value => value as DecisionId)

/** Objective reference at the durable boundary; an opaque cross-domain id. */
const objectiveRef = z.string().transform(value => value as ObjectiveId)

/** Confidence: a number in [0, 1]. */
const confidence = z.number().min(0).max(1)

/** One option row on the card. */
const decisionOption = z.object({
  label: z.string().min(1),
  evidence: z.string(),
  cost: z.string().min(1).optional(),
  risk: z.string().min(1).optional(),
})

/** Reversibility vocabulary. */
const reversibility = z.enum(['reversible', 'costly', 'irreversible'])

/**
 * Durable shape of one decision record. `counterEvidence` is mandatory as a
 * field (may be an empty string); `predictedConfidence` is the decide-time
 * snapshot calibration reads; timestamps are ISO-8601 strings.
 */
export const decisionRecord = z.object({
  question: z.string().min(1),
  objectiveId: objectiveRef.optional(),
  options: z.array(decisionOption),
  counterEvidence: z.string(),
  recommendation: z.string().min(1).optional(),
  rationale: z.string().min(1).optional(),
  confidence: confidence.optional(),
  reversibility,
  status: z.enum(['open', 'decided', 'superseded']),
  chosen: z.string().min(1).optional(),
  predictedConfidence: confidence.optional(),
  decidedAt: z.string().min(1).optional(),
  dueAt: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

/** One stored decision record, inferred from {@link decisionRecord}. */
export type DecisionRecord = z.infer<typeof decisionRecord>

/**
 * Durable registry state; `decisionIds` is the authoritative display order.
 * Order and records are written record-first; startup validation fails loud
 * on any divergence between the two.
 */
export const decisionDomainState = z.object({
  decisionIds: z.array(decisionId),
})

/** Durable registry state inferred from {@link decisionDomainState}. */
export type DecisionDomainState = z.infer<typeof decisionDomainState>

/** Durable shape of one review record. */
export const decisionReviewRecord = z.object({
  id: decisionId,
  decisionId,
  objectiveId: objectiveRef.optional(),
  reviewedAt: z.string().min(1),
  predictedConfidence: confidence.optional(),
  actualOutcome: z.string().min(1),
  calibrationNote: z.string().min(1).optional(),
})

/** One stored review record; shape-identical to the consumer {@link DecisionReview}. */
export type DecisionReviewRecord = z.infer<typeof decisionReviewRecord>

/**
 * The decision domain spec: one `decisions` table keyed by
 * {@link DecisionId}, one `decisionReviews` table keyed by review id, plus
 * the order singleton. The registry opens this through `ctx.storage.domain`.
 */
export const decisionDomainSpec = defineDomain({
  name: 'decision',
  version: 1,
  global: {
    schema: decisionDomainState,
    initial: { decisionIds: [] },
  },
  tables: {
    decisions: domainTable<DecisionId, DecisionRecord>(decisionRecord),
    reviews: domainTable<DecisionId, DecisionReviewRecord>(decisionReviewRecord),
  },
})
