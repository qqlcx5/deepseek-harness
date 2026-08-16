/**
 * Public type vocabulary of the objective domain: the `ObjectiveId` brand,
 * consumer views, mutation requests, and the live-change notification. Types
 * only — no runtime code (the `ObjectiveId` factory lives in `index.ts`).
 * @module @deepseek-ai/dsh-objective/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Identifies one objective record. A generated uuid, never the title: titles
 * are editable and a reference anchor must stay stable.
 */
export type ObjectiveId = Branded<'ObjectiveId'>

/** Durable lifecycle status of one objective. */
export type ObjectiveStatus = 'active' | 'parked' | 'closed'

/**
 * One cross-session objective: a north-star intent with an ordered member
 * account of sessions. `sessionIds` is display order (newest first); a
 * session may serve several objectives and an objective may span workspaces,
 * so this account is orthogonal to workspace membership. Consumers only see
 * this interface; the durable record and its validators live in `spec.ts`.
 */
export interface ObjectiveView {
  /** Stable record id (generated uuid). */
  readonly id: ObjectiveId

  /** Display title; non-empty, duplicates across objectives allowed. */
  readonly title: string

  /** North-star statement of done, in the owner's words; absent when unset. */
  readonly northStar?: string

  /** Durable lifecycle status. */
  readonly status: ObjectiveStatus

  /** Cached objective-level brief produced by a synthesis consumer; absent when none was written. */
  readonly brief?: string

  /** ISO-8601 instant of the last brief write; present exactly when {@link brief} is. */
  readonly briefAt?: string

  /** Member sessions in manual order: a new member is prepended at attach. */
  readonly sessionIds: readonly SessionId[]

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string
}

/** Input to {@link ObjectiveRegistry.create}; the title is required. */
export interface CreateObjectiveRequest {
  /** Non-empty display title. */
  readonly title: string
  /** Optional north-star statement; stored verbatim when non-empty. */
  readonly northStar?: string
}

/**
 * Fields changed by an update; at least one must be present. A present
 * `null` north-star clears the statement; an absent field leaves it alone.
 */
export interface UpdateObjectiveRequest {
  /** Replacement non-empty display title. */
  readonly title?: string
  /** Replacement north-star statement, or `null` to clear it. */
  readonly northStar?: string | null
  /** Replacement lifecycle status. */
  readonly status?: ObjectiveStatus
}

/** Verbs recorded by the live `objective/changed` notification. */
export type ObjectiveOperation = 'create' | 'update' | 'attach' | 'detach' | 'brief' | 'delete'

/** Live notification after one durable objective mutation commits. */
export interface ObjectiveChanged {
  /** Which mutation committed. */
  readonly operation: ObjectiveOperation
  /** The post-mutation view; absent for a delete. */
  readonly objective?: ObjectiveView
}
