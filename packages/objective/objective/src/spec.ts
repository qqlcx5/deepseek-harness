/**
 * The objective domain declaration: record schema and the `defineDomain`
 * spec the registry opens. The zod schema is the durable-boundary validator.
 * @module @deepseek-ai/dsh-objective/src/spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ObjectiveId } from './types.ts'

/** Objective id schema at the durable boundary; branding has no runtime representation. */
const objectiveId = z.string().transform(value => value as ObjectiveId)

/**
 * Durable shape of one objective record. `sessionIds` is the ordered member
 * account (newest first); `brief`/`briefAt` are the cached synthesis pair;
 * timestamps are ISO-8601 strings.
 */
export const objectiveRecord = z.object({
  title: z.string().min(1),
  northStar: z.string().min(1).optional(),
  status: z.enum(['active', 'parked', 'closed']),
  brief: z.string().min(1).optional(),
  briefAt: z.string().min(1).optional(),
  sessionIds: z.array(z.string().transform(SessionId)),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

/** One stored objective record, inferred from {@link objectiveRecord}. */
export type ObjectiveRecord = z.infer<typeof objectiveRecord>

/**
 * Durable registry state; `objectiveIds` is the authoritative display order.
 * Unlike the workspace domain there is no bootstrap and no pending-mutation
 * marker: order and records are written record-first, and startup validation
 * fails loud on any divergence between the two.
 */
export const objectiveDomainState = z.object({
  objectiveIds: z.array(objectiveId),
})

/** Durable registry state inferred from {@link objectiveDomainState}. */
export type ObjectiveDomainState = z.infer<typeof objectiveDomainState>

/**
 * The objective domain spec: one `objectives` table keyed by
 * {@link ObjectiveId} plus the order singleton. The registry opens this
 * through `ctx.storage.domain`.
 */
export const objectiveDomainSpec = defineDomain({
  name: 'objective',
  version: 1,
  global: {
    schema: objectiveDomainState,
    initial: { objectiveIds: [] },
  },
  tables: { objectives: domainTable<ObjectiveId, ObjectiveRecord>(objectiveRecord) },
})
