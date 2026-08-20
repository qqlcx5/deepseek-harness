# @deepseek-ai/dsh-decision-drafter

[English](README.md) | 中文

决策起草 meta-agent:经 [subagent 缝](../../subagent/subagent/README.md)的一次 fan-in——收集决策问题及其目标的 brief 与成员结论,委派一个 one-shot 结构化 child,并经 `ctx.decisions.update` 存储决策卡草稿——选项、带理由与置信度的推荐、可逆性建议,以及必填的反证段。它绝不写 `decided`:拍板始终是人类交互。设计理由见 [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md)。

## Config

```yaml
- id: decision-drafter
  name: '@deepseek-ai/dsh-decision-drafter'
  config:
    provider: spawn
    materialTail: 3
    messageCapChars: 2000
```

`provider` 命名已注册的 `ctx.subagents` 提供方;`materialTail` 与 `messageCapChars` 与 `dsh-objective-synthesizer` 一致地约束目标材料。

## Delegation contract

`draftDecision(ctx, resolved, parent, decisionId, objectiveId, signal)` 解析一个 **open** 决策(历史不重起草),读取目标——显式片段优先,其次决策自身的链接;链接解析不到时无目标上下文起草而非失败——经与综述体相同的材料路径收集 brief 与成员结论,并以 `maxDepth: 0` 启动一个 child。child 必须返回完整卡片;结构化结果缺失或畸形以稳定的 `DecisionDrafterError` 码拒绝,基础设施故障原样重抛。run 总会被 dispose。存储的卡经注册表自身校验(选项 label 唯一、置信度在 [0, 1])。

`/decide-draft <decision id> [objective id]` 命令走同一路径,回复起草摘要与继续所需的 `/decide show`、`/decide choose` 确切调用。

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

- **仅命令触发** — 自动起草触发(证据阈值、目标事件)等待调度消费者;委派路径已导出供其使用。
- **每次运行整卡替换** — 重起草经 `update` 替换整张卡;增量合并等消费者出现再说。
- **可逆性只是建议** — 起草的分诊会覆盖决策字段;人是权威,可经服务改回。
