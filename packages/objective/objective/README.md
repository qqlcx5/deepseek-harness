# @deepseek-ai/dsh-objective

English | [中文](README.zh.md)

Cross-session objective registry. The service owns durable north-star records — intent containers that outlive any one session — with an ordered member account of sessions, over the [storage domain form](../../storage/storage-domain/README.md). The [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) owns the design rationale.

An objective is orthogonal to a workspace: workspace membership is per-directory, objective membership is per-intent, and one session may serve several objectives. Same-session execution goals belong to `ctx.goals`; an objective may reference a session's goal without owning it.

## Service contract

`ctx.objectives` exposes create, get, list, update, attachSession, detachSession, objectivesOf, setBrief, and delete. Mutations run on a serialized write chain and publish `objective/changed` only after the durable write succeeds. Startup validates that registry order and the record table agree exactly and fails loud on divergence.

Every status transition is legal — close is not terminal, and reopening an objective is a supported flow. The member account is newest-first; attach and detach are idempotent. **New membership requires an active objective**: a parked objective accepts no new members (it is the WIP lever, and it still counts against the cap), and a closed one must be reopened first; an already-accounted member keeps resolving on the idempotent path. Membership writes the domain first: the domain is the membership authority. A live member session additionally receives a log-only `objective/member` session event (per-objective last action wins; `foldObjectiveMembership(events)` folds one session's effective affiliations), whose failure is logged and never rolls the domain write back. A session that is neither live nor persisted is attached on the domain alone.

The brief is the cached synthesis output (`setBrief` stamps `briefAt`); it is data, not scheduling. An optional third argument fences concurrent brief writers compare-and-set style: a caller passes the `briefAt` it read (or `null` when none) and a mismatch — another writer stored a brief in between — rejects with `OBJECTIVE_STALE_BRIEF` instead of silently overwriting. The separately published `./invariant` companion rejects malformed `objective/member` payloads before they enter the durable log.

## Extension points

Consumers react to `objective/changed` after durable commits. A synthesis consumer reads member sessions through a query seam, writes the brief through `setBrief`, and delivers it into a member session only through a logged inject. An attribution consumer proposes `attachSession`/`detachSession`; the human confirmation surface belongs to the consumer.

## Model Experience

None, as this package writes no model-visible input: the log-only `objective/member` event and the domain brief never enter model context. A consumer injecting the brief through `agent.inject()` owns its own model experience.

#### KV Cache effect

The package contributes no model request content, so it cannot invalidate an existing request prefix. The `objective/member` event appends to the session log outside the ordered surface and never appears in a derived model history.

## Known Limitations and Deferred Work

- **WIP cap deferred** — a maximum-active-objectives signal needs its command-surface consumer; a config field with no consumer stays out.
- **Best-effort log mirror** — membership of a non-live session lands on the domain only, and a failed mirror append leaves the session log without the edge; the domain remains the authority and cold reads of that session show no affiliation.
- **Membership requires active status** — parked and closed objectives reject new members by design (the WIP lever); the same rule gates nothing else: detach, brief, and delete work on any status.
- **Delete crash window** — a crash between the order write and the record deletion leaves an orphan record that the next startup rejects loudly; recovery is manual medium repair.
- **No RPC surface** — the service is host-side only; a Typert export and client projection wait for a concrete remote consumer.
- **Trusted in-process producers** — a plugin with direct `Session` access can append a well-formed counterfeit `objective/member` event. The invariant companion detects malformed payloads; well-formed counterfeits are integrity detection, not plugin isolation.
