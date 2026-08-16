# Agent Note: Convergence layers — Objective, Claim, Decision

Status: proposed

English | [中文](2026-08-16-agentdeck-convergence-layers.zh.md)

## Problem

Parallel agents produce conclusions that the harness records as sessions and nothing else. Three gaps follow, each observed in real multi-agent use:

1. **Intent scatters.** One user goal spans many sessions over days. [`ctx.goals`](../../implemented/feature/2026-07-19-persisted-same-session-goal-domain.md) tracks one same-session objective; `ctx.workspaceRegistry` groups sessions by directory. Nothing answers "what did all sessions serving this goal conclude, and what is still open?"
2. **Knowledge fragments.** An audit conclusion lives in one session log, a related memory in another, with no deduplication, linking, contradiction detection, or expiry. A later agent reuses a superseded conclusion because nothing detects the conflict.
3. **Decisions leave no trace.** The user's own strategic decisions — repair versus rewrite, which P0 first — happen in chat, are never first-class objects, and cannot be reviewed or calibrated afterward.

The source design is AgentDeck v2.0, a user-supplied external design document for a personal agent-attention and convergence product. It specifies the three layers below (Objective, Claim, Decision), five "meta-agent" integration roles, and one governing principle: delegation is legitimate only when it reduces the information a human must read directly. This note owns the harness-side mapping; the external document owns the product motivation.

## Proposal

Three capability seams, one per layer, each persisted through the [storage domain form](2026-07-24-domain-kv-storage-and-workspace.md) and each shippable independently. Each package group follows the `goal/` decomposition: a Service Definition package, a model-facing tool package, and a human command package.

| Layer | Group | Domain tables | Meta-agents (Consumers) |
|---|---|---|---|
| Objective | `packages/objective/` | `objective`, `objective_member` | synthesizer, attributor |
| Knowledge | `packages/knowledge/` | `claim`, `claim_edge` | extractor, sentinel |
| Decision | `packages/decision/` | `decision`, `decision_review` | drafter, reviewer |

### Phase A — Objective (intent layer)

- `ObjectiveId` is a branded id. The `objective` table records title, north-star statement, status (`active`/`parked`/`closed`), the cached objective-level brief, and its timestamp; `objective_member` records the many-to-many session↔objective membership.
- Membership is written twice: as a domain row, and as a log-only `objective/member` session event on the member session (the log-only pattern of `subagent/descriptor`), so a cold read of one session recovers its objectives from the log alone.
- Attribution defaults to AI-proposed, human-confirmed: a meta-agent proposes membership from `SessionHeader.cwd`, the first prompt, and existing objective titles (precedent: the session-title LLM providers); the human confirms or corrects through a command. Unattributed sessions surface in an explicit "unassigned" view; the unattributed ratio is a health signal, not a hard gate.
- The objective-level brief is produced by a one-shot subagent with an output schema (one paragraph of current conclusions plus up to three open questions), reading member sessions through the session-query seam, and written back to `objective.brief`. It reaches a model only through `agent.inject()`, so the injected text is logged; it is never assembled silently into a request.
- The WIP cap is a validated config field (soft signal at the command surface), mirroring the deployment-tunable rule.

### Phase B — Knowledge (claim layer)

- `ClaimId` is a branded id. A claim is one atomic proposition plus provenance (`sourceKind`, `sourceUri`, `sourceSession` with an event anchor), confidence, `validUntil`, and status (`active`/`retired`/`promoted`; supersession is an edge, not a status). `claim_edge` is keyed by the claim pair with relation `supports`/`refines`/`supersedes`/`contradicts`.
- The extractor listens for `subagent/end` and long final assistant messages, delegates extraction to a one-shot subagent with a claim output schema, and writes claims whose provenance resolves to the producing session log record.
- The sentinel runs on claim write: a one-shot subagent checks the new claim against existing claims, producing either "no conflict" or a conflict report naming both sources. A report raises a non-blocking alarm at the command surface; human adjudication writes the `supersedes` or `contradicts` edge and retires or confirms the affected claims.
- Promotion exports a cross-confirmed claim to the deployment's persistent memory surface; an expired `validUntil` downgrades the claim to a review state. Both are human-confirmed actions.

### Phase C — Decision (decision layer)

- `DecisionId` is a branded id. A decision records the question, options (each with cited claim ids, cost, and risk), recommendation with rationale, confidence, reversibility (`reversible`/`costly`/`irreversible`), status (`open`/`decided`/`superseded`), chosen option, and decided/due timestamps. `decision_review` records the predicted confidence against the one-line actual outcome.
- The drafter clusters related claims into a draft decision card (one-shot subagent, output schema). The human approves, edits, or rejects through the user-questions seam; approval is a user interaction, never an automatic write.
- Reversibility triages the approval path: a reversible option follows the fast path (approve from the card), an irreversible one requires the cited claims' sources to be opened in the same interaction before approval is offered.
- Reviews ride the schedule seam: a due decision produces one low-friction follow-up ("did it work? one line or a choice"). Predicted-versus-actual accumulates into a calibration view. When the sentinel supersedes a claim cited by a decided decision, that decision is marked for re-review.

### The delegation rule

Every meta-agent run goes through the existing [subagent seam](../../implemented/feature/2026-06-21-subagent-capability-seam.md) as a one-shot child with `outputSchema` and a persona, and is allowed only as fan-in: the run must reduce the information a human must read directly. No multi-step pipelines between tools, no business automation. Each layer's package group carries its own meta-agent wiring; extracting a shared delegation host is deferred until the trigger→delegate→write-back sequence demonstrably repeats.

This proposal consumes the [storage domain form](2026-07-24-domain-kv-storage-and-workspace.md) and the subagent, session-query, user-questions, schedule, and commands seams; it supersedes none of them, extends no session event map beyond the log-only `objective/member`, and adds no agent-loop change.

## Alternatives considered

**Extend `ctx.goals` to cross-session objectives.** Rejected: goal state is event-sourced from one session log, and a cross-session registry would break that single-log fold while conflating same-session execution goals with long-lived intent containers. A goal remains the execution view of one session; an objective references sessions, and may reference a session's goal, without owning it.

**Group by workspace only.** Rejected: workspace membership is per-directory and objective membership is per-intent; one session may serve several objectives and one objective spans directories. The two groupings are orthogonal records over the same sessions.

**Markdown files instead of a domain.** Rejected: contradiction detection and evidence linking need structured queries and typed ids; the storage domain is the existing seam for cross-session typed state, with backend swaps for free.

**A single meta-agent host package.** Deferred: three groups wiring their own delegation is mild duplication; a host package is extracted when the sequence actually repeats, not before.

**Continuable resident meta-agents.** Deferred: one-shot children with structured output cover all six roles; residency adds activation ownership and teardown surface for no current requirement.

## Acceptance criteria

- Each phase lands as a complete capability seam (Service Definition, storage-domain tables, at least one model- or human-facing Consumer) and composes independently in a profile.
- Objective membership is recoverable from the member session log alone; a brief reaches a model only through a logged inject.
- Every claim, alarm, and decision card carries provenance resolving to a session log record; an alarm renders both conflicting sources.
- Sentinel alarms never block a claim write; adjudication is recorded as an edge.
- An irreversible decision cannot be approved without the interaction surface presenting the cited evidence.
- A keyless assembled snapshot exists per phase (multi-session objective with brief; extracted claim with a detected and adjudicated contradiction; drafted decision approved through the interaction seam), through real runnable examples per the testing policy.
- No change to the agent loop; all behavior attaches through documented extension points.

## Risks

- **Structuring burden.** Requiring humans to fill fields would recreate the fragmentation the layers exist to remove. Attribution, extraction, and drafting therefore default to AI-proposed with human confirmation; manual entry is the fallback.
- **Convergence distortion propagates into decisions.** A wrong summary or claim is invisible without provenance. Every derived artifact carries source links, irreversible approvals force reading sources, and the sentinel catches knowledge-level conflicts; this is a mitigation, not a guarantee.
- **Sentinel noise.** False alarms erode trust and get muted. Alarms advise without blocking, adjudication is one gesture, and adjudication outcomes tune the check's thresholds.
- **Scope creep toward a general workflow platform.** The delegation rule above is the guard: a proposed meta-agent that cannot argue it reduces human-read information is out of scope, and the answer is recorded in review, not left to judgment at runtime.
