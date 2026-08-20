/**
 * Public type vocabulary of the decision domain: the `DecisionId` brand,
 * consumer views, mutation requests, and review records. Types only — no
 * runtime code (the `DecisionId` factory lives in `index.ts`).
 * @module @deepseek-ai/dsh-decision/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ObjectiveId } from '@deepseek-ai/dsh-objective'

/**
 * Identifies one decision record. A generated uuid: a decision is a first
 * class object with its own lifecycle, never a session message reference.
 */
export type DecisionId = Branded<'DecisionId'>

/** Approval-path triage: how expensive it is to undo the chosen option. */
export type Reversibility = 'reversible' | 'costly' | 'irreversible'

/** Durable lifecycle status of one decision. */
export type DecisionStatus = 'open' | 'decided' | 'superseded'

/** One option on a decision card. Evidence is free-form first; claim-id
 * backfill arrives with the knowledge layer. */
export interface DecisionOption {
  /** Short option label; unique within one decision. */
  readonly label: string
  /** What supports this option, as free-form references the human can read. */
  readonly evidence: string
  /** One-line cost of taking this option; absent when unquantified. */
  readonly cost?: string
  /** One-line risk of taking this option; absent when unquantified. */
  readonly risk?: string
}

/**
 * One strategic decision as a first-class object: the question, its option
 * card with evidence and costs, the recommendation with its rationale and
 * confidence, the mandatory counter-evidence section, reversibility triage,
 * and the lifecycle trail. `confidence` is the author's current number
 * (0–1); `predictedConfidence` is the snapshot frozen at decide time and is
 * what calibration compares against outcomes.
 */
export interface DecisionView {
  /** Stable record id (generated uuid). */
  readonly id: DecisionId

  /** The question this decision answers; non-empty. */
  readonly question: string

  /** Owning objective, when the decision serves one; absent otherwise. */
  readonly objectiveId?: ObjectiveId

  /** The option card; may be empty while the question is still open. */
  readonly options: readonly DecisionOption[]

  /**
   * Known counter-evidence: what argues against the recommendation (or
   * against deciding at all). Empty is allowed, absent is not — the drafter
   * that sets the agenda must also surface what it knows against it.
   */
  readonly counterEvidence: string

  /** Recommended option label; absent until a draft exists. */
  readonly recommendation?: string

  /** Why the recommendation is what it is; absent until a draft exists. */
  readonly rationale?: string

  /** Author's confidence in the recommendation, 0–1; absent until drafted. */
  readonly confidence?: number

  /** Approval-path triage recorded at create time. */
  readonly reversibility: Reversibility

  /** Durable lifecycle status. */
  readonly status: DecisionStatus

  /** Chosen option label; present exactly while status is `decided`. */
  readonly chosen?: string

  /** Confidence snapshot frozen when the decision was made. */
  readonly predictedConfidence?: number

  /** ISO-8601 instant the decision was made; present once decided. */
  readonly decidedAt?: string

  /** Optional review-due instant. */
  readonly dueAt?: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation. */
  readonly updatedAt: string
}

/** Input to {@link DecisionRegistry.create}; only the question is required. */
export interface CreateDecisionRequest {
  /** The strategic question; non-empty. */
  readonly question: string
  /** Owning objective, when known. */
  readonly objectiveId?: ObjectiveId
  /** Initial option card; may be empty. */
  readonly options?: readonly DecisionOption[]
  /** Approval-path triage; defaults to `reversible`. */
  readonly reversibility?: Reversibility
  /** Optional review-due instant (ISO-8601). */
  readonly dueAt?: string
}

/**
 * Fields a draft update may replace on an open decision; at least one must be
 * present. A present `null` clears recommendation/rationale/confidence/dueAt.
 */
export interface UpdateDecisionRequest {
  /** Replacement question. */
  readonly question?: string
  /** Replacement option card. */
  readonly options?: readonly DecisionOption[]
  /** Replacement counter-evidence section (may be empty, never absent). */
  readonly counterEvidence?: string
  /** Replacement recommended option label, or `null` to clear. */
  readonly recommendation?: string | null
  /** Replacement rationale, or `null` to clear. */
  readonly rationale?: string | null
  /** Replacement confidence (0–1), or `null` to clear. */
  readonly confidence?: number | null
  /** Replacement approval-path triage. */
  readonly reversibility?: Reversibility
  /** Replacement review-due instant, or `null` to clear. */
  readonly dueAt?: string | null
}

/** Verbs recorded by the live `decision/changed` notification. */
export type DecisionOperation = 'create' | 'update' | 'decide' | 'supersede' | 'review' | 'delete'

/** Live notification after one durable decision mutation commits. */
export interface DecisionChanged {
  /** Which mutation committed. */
  readonly operation: DecisionOperation
  /** The post-mutation view; absent for a delete. */
  readonly decision?: DecisionView
}

/** One calibration data point: what was predicted against what happened. */
export interface DecisionReview {
  /** Stable review record id (generated uuid). */
  readonly id: DecisionId
  /** The reviewed decision. */
  readonly decisionId: DecisionId
  /** Objective snapshot from the decision at record time; survives decision deletion. */
  readonly objectiveId?: ObjectiveId
  /** ISO-8601 review instant. */
  readonly reviewedAt: string
  /** Confidence frozen at decide time; absent when decided without one. */
  readonly predictedConfidence?: number
  /** One-line actual outcome; non-empty. */
  readonly actualOutcome: string
  /** Optional free-form calibration note. */
  readonly calibrationNote?: string
}
