# @deepseek-ai/dsh-decision-drafter

English | [中文](README.zh.md)

Decision drafting meta-agent: one fan-in pass over the [subagent seam](../../subagent/subagent/README.md) that gathers the decision question plus its objective's brief and member conclusions, delegates one one-shot structured child, and stores the draft card through `ctx.decisions.update` — options, recommendation with rationale and confidence, a reversibility suggestion, and the mandatory counter-evidence section. It never writes `decided`: choosing stays a human interaction. The [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) owns the design rationale.

## Config

```yaml
- id: decision-drafter
  name: '@deepseek-ai/dsh-decision-drafter'
  config:
    provider: spawn
    materialTail: 3
    messageCapChars: 2000
```

`provider` names the registered `ctx.subagents` provider; `materialTail` and `messageCapChars` bound the objective material exactly as in `dsh-objective-synthesizer`.

## Delegation contract

`draftDecision(ctx, resolved, parent, decisionId, objectiveId, signal)` resolves an **open** decision (history never redrafts), reads the objective — an explicit fragment wins, else the decision's own link; a link that resolves to nothing drafts without objective context rather than failing — collects the brief plus member conclusions through the same material path as the synthesizer, and starts one child with `maxDepth: 0`. The child must return the full card; a missing or malformed structured result rejects with a stable `DecisionDrafterError` code, and infrastructure faults rethrow as themselves. The run is always disposed. The stored card goes through the registry's own validation (option labels unique, confidence in [0, 1]).

The `/decide-draft <decision id> [objective id]` command rides the same path and answers with the drafted summary plus the exact `/decide show` and `/decide choose` invocations to continue.

## Model Experience

### Drafting child prompt

#### What the model sees

One user-role text block per run: the stable instruction below, the question, the objective title and brief when linked, and one material block per member session.

##### The drafting instruction

```markdown
You are the drafting step for one strategic decision. From the question and the material
below, draft the decision card: the realistic options with their evidence, cost, and risk; one
recommendation with its rationale and your confidence in [0, 1]; a reversibility suggestion;
and the counter-evidence section — what the material says AGAINST the recommendation or
against deciding now. The counter-evidence may be an empty string only when nothing in the
material argues against; never invent, never omit what is there. Use only the material.
Return the structured result and nothing else.
```

#### Token effect

One independent child request per drafting run, sized by the material. The parent session spends no tokens on the pass itself.

#### KV Cache effect

The child request is independent; the parent's reusable prefix is untouched. The child's prompt is unique per run, so no prefix reuse is expected within the pass.

## Known Limitations and Deferred Work

- **Command-triggered only** — automatic drafting triggers (evidence-threshold, objective events) wait for a scheduling consumer; the delegation path is exported for one.
- **One card per run** — re-drafting replaces the whole card through `update`; incremental merges are out of scope until a consumer needs them.
- **Reversibility is a suggestion** — the drafted triage overwrites the decision's field; the human is the authority and may change it back through the service.
