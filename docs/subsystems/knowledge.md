# Knowledge (claims)

English | [中文](knowledge.zh.md)

Cross-session claim registry: [dsh-knowledge](../../packages/knowledge/knowledge) owns atomic propositions with provenance and the edge graph over them — supports, refines, supersedes, contradicts — over the [storage domain form](storage.md). Supersession and conflict are edges, not statuses; promotion requires corroboration from distinct document roots. The [convergence-layers Agent Note](../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) owns the design rationale; the [package README](../../packages/knowledge/knowledge/README.md) owns the service contract detail.

## Provenance and edges

Provenance is mandatory at create; `canonicalDocumentUri` strips fragments and line anchors so evidence distinctness is judged at document granularity. `link` writes one relation per ordered pair; edges survive the deletion of the claims they name.

## Service behavior

Mutations run on a serialized write chain and publish `claim/changed` only after the durable write succeeds. Startup validates that registry order and the claims table agree exactly and fails loud on divergence.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclaims--claimregistry"></a>

### `ctx.claims` — `ClaimRegistry`

Claim registry (`ctx.claims`) over the storage domain form. Startup validates that registry order and the claims table agree exactly; edge rows survive the deletion of the claims they mention (an edge naming an absent claim is inert data, not corruption). Every mutation runs on a serialized write chain and publishes `claim/changed` only after the durable write succeeds.

```ts cordis-catalog
/**
 * Create an active claim with mandatory provenance and prepend it to the
 * durable registry order.
 * @param request - The proposition, its source, and optional context.
 * @returns the created view.
 */
async create(request: CreateClaimRequest): Promise<ClaimView>

/**
 * Look up a claim by id.
 * @param id - Claim id.
 * @returns the detached view, or `undefined` when unknown.
 */
get(id: ClaimId): ClaimView | undefined

/**
 * Synchronous claim projection in durable registry order. Performs no
 * persistence reads.
 * @returns a fresh ordered array of detached views.
 */
list(): ClaimView[]

/**
 * The active (non-retired, non-promoted) claims in registry order.
 * @returns every claim whose status is `active`.
 */
listActive(): ClaimView[]

/**
 * Link two claims with one relation. The ordered pair carries at most one
 * relation: re-linking the same pair replaces it. Both claims must exist;
 * a self-edge rejects.
 * @param src - Source claim of the relation.
 * @param dst - Destination claim of the relation.
 * @param relation - The relation from src to dst.
 */
async link(src: ClaimId, dst: ClaimId, relation: ClaimEdgeRelation): Promise<void>

/**
 * Every edge touching one claim, in registry order: outgoing and incoming.
 * @param id - Claim id.
 * @returns the edges whose src or dst is the claim.
 */
edgesOf(id: ClaimId): ClaimEdge[]

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
async promote(id: ClaimId, corroboratedBy: readonly string[]): Promise<ClaimView>

/**
 * Retire a claim: it stays readable with its trail but leaves the active
 * set. Idempotent for an already-retired claim.
 * @param id - Claim id.
 * @returns the retired view.
 */
async retire(id: ClaimId): Promise<ClaimView>

/**
 * Delete one claim record while retaining every edge mentioning it (an
 * edge naming an absent claim is inert). Idempotent for an unknown id.
 * @param id - Claim to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
async delete(id: ClaimId): Promise<boolean>
```

Source: [`packages/knowledge/knowledge/src/index.ts:156`](../../packages/knowledge/knowledge/src/index.ts)

<a id="claim-events"></a>

### `claim/*` events

<a id="claimchanged--emit"></a>

#### `claim/changed` — emit

One durable claim mutation committed.

```ts cordis-catalog
/**
 * One durable claim mutation committed.
 * @param payload.operation - which mutation committed.
 * @param payload.claim - post-mutation view; absent for a delete.
 * @mode emit
 */
'claim/changed'(payload: ClaimChanged): void
```

Source: [`packages/knowledge/knowledge/src/index.ts:94`](../../packages/knowledge/knowledge/src/index.ts)
<!-- END GENERATED cordis-surface -->
