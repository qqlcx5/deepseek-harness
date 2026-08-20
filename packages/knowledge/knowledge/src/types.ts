/**
 * Public type vocabulary of the knowledge domain: the `ClaimId` brand, the
 * edge relations, consumer views, and mutation requests. Types only — no
 * runtime code (the `ClaimId` factory lives in `index.ts`).
 * @module @deepseek-ai/dsh-knowledge/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ObjectiveId } from '@deepseek-ai/dsh-objective'

/**
 * Identifies one claim record. A generated uuid: a claim is an atomic
 * proposition with provenance, never a session message reference.
 */
export type ClaimId = Branded<'ClaimId'>

/** Edge relations between two claims. Supersession and conflict are edges,
 * not statuses: a superseded claim stays readable with its trail. */
export type ClaimEdgeRelation = 'supports' | 'refines' | 'supersedes' | 'contradicts'

/** Durable lifecycle status of one claim. */
export type ClaimStatus = 'active' | 'retired' | 'promoted'

/** Where a claim's proposition came from: the kind of artifact it cites. */
export type ClaimSourceKind = 'session' | 'artifact' | 'memory' | 'external'

/**
 * One atomic proposition with provenance: what is claimed, where it came
 * from, how confident it is, and how long it should be trusted. Evidence
 * distinctness is judged at canonical document granularity — two anchors
 * inside one artifact never count as two sources.
 */
export interface ClaimView {
  /** Stable record id (generated uuid). */
  readonly id: ClaimId

  /** The atomic proposition; non-empty. */
  readonly proposition: string

  /** What kind of source the provenance cites. */
  readonly sourceKind: ClaimSourceKind

  /** Canonical source location: resolvable back to the producing record. */
  readonly sourceUri: string

  /** Producing session, when the source is a session log. */
  readonly sourceSession?: string

  /** Event anchor inside the source session, when applicable. */
  readonly sourceAnchor?: string

  /** Confidence in [0, 1]; absent when unjudged. */
  readonly confidence?: number

  /** ISO-8601 instant after which the claim needs re-validation. */
  readonly validUntil?: string

  /** Durable lifecycle status. */
  readonly status: ClaimStatus

  /** Owning objective, when the claim serves one; absent otherwise. */
  readonly objectiveId?: ObjectiveId

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation. */
  readonly updatedAt: string
}

/** One edge between two claims; one relation per ordered pair. */
export interface ClaimEdge {
  /** Source claim of the relation. */
  readonly src: ClaimId
  /** Destination claim of the relation. */
  readonly dst: ClaimId
  /** The relation from `src` to `dst`. */
  readonly relation: ClaimEdgeRelation
}

/** Input to {@link ClaimRegistry.create}; provenance is mandatory. */
export interface CreateClaimRequest {
  /** The atomic proposition; non-empty. */
  readonly proposition: string
  /** What kind of source the provenance cites. */
  readonly sourceKind: ClaimSourceKind
  /** Canonical source location. */
  readonly sourceUri: string
  /** Producing session id, when the source is a session log. */
  readonly sourceSession?: string
  /** Event anchor inside the source session, when applicable. */
  readonly sourceAnchor?: string
  /** Confidence in [0, 1]; absent when unjudged. */
  readonly confidence?: number
  /** Review-due instant. */
  readonly validUntil?: string
  /** Owning objective, when known. */
  readonly objectiveId?: ObjectiveId
}

/** Verbs recorded by the live `claim/changed` notification. */
export type ClaimOperation = 'create' | 'link' | 'promote' | 'retire' | 'delete'

/** Live notification after one durable claim mutation commits. */
export interface ClaimChanged {
  /** Which mutation committed. */
  readonly operation: ClaimOperation
  /** The post-mutation view; absent for a delete. */
  readonly claim?: ClaimView
}
