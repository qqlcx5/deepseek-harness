# @deepseek-ai/dsh-objective-synthesizer

English | [中文](README.zh.md)

Objective synthesis meta-agent: one fan-in pass over the [subagent seam](../../subagent/subagent/README.md) that collects each member session's trailing conclusions through the session-query seam, delegates one one-shot structured child, and stores the objective's cached brief through `ctx.objectives.setBrief`. The [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) owns the design rationale.

## Config

```yaml
- id: objective-synthesizer
  name: '@deepseek-ai/dsh-objective-synthesizer'
  config:
    provider: spawn
```

`provider` names the registered `ctx.subagents` provider that runs the synthesis child; the default `spawn` matches the stock spawn-in-process backend.

## Delegation contract

`synthesizeObjective(ctx, provider, parent, objectiveId, signal)` reads the objective, collects one material block per member session (the trailing three assistant text messages, capped at 2000 characters each, through `ctx.sessionQuery.readSession`), and starts one child with `maxDepth: 0` — the synthesis child cannot delegate further, so the pass is fan-in only. The child must return `{ brief, openQuestions }`; the stored brief renders the paragraph plus the non-blank open questions. A run with no member sessions, a child that ends without `stopReason: 'completed'`, or a missing or malformed structured result rejects with a stable `ObjectiveSynthesisError` code; infrastructure faults rethrow as themselves. The run is always disposed.

The package registers the `/synthesize <objective id>` human command over the same path: it resolves the id fragment, runs the delegation anchored on the commanding agent, and prints the stored brief.

## Model Experience

### Synthesis child prompt

#### What the model sees

One user-role text block per run: the stable instruction below, the objective title and north-star statement, and one material block per member session.

##### The synthesis instruction

```markdown
You are the synthesis step for one cross-session objective. From the member-session material
below, write exactly one paragraph stating what the sessions collectively concluded so far,
then at most three open questions a decision still waits on. Use only the material; do not
invent progress. Return the structured result and nothing else.
```

#### Token effect

One independent child request per synthesis run, sized by the material (member count × trailing messages, each capped). The parent session spends no tokens on the pass itself.

#### KV Cache effect

The child request is independent; the parent's reusable prefix is untouched. The child's prompt is unique per run, so no prefix reuse is expected within the pass.

## Known Limitations and Deferred Work

- **Command-triggered only** — automatic triggers (objective activity, a triage window) wait for a scheduling consumer; the delegation path is exported for one.
- **Trailing-message material** — the brief sees the last three assistant messages per member; older conclusions are reachable only through a compaction-aware collector.
- **No caching between runs** — every `/synthesize` re-reads all member logs; incremental synthesis waits for an event-fed material collector.
