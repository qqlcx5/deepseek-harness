# @deepseek-ai/dsh-objective-synthesizer

[English](README.md) | 中文

目标综述 meta-agent:经 [subagent 缝](../../subagent/subagent/README.md)的一次 fan-in——通过 session-query 缝收集每个成员会话的尾部结论,委派一个 one-shot 结构化 child,并经 `ctx.objectives.setBrief` 存储目标的缓存 brief。设计理由见 [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md)。

## Config

```yaml
- id: objective-synthesizer
  name: '@deepseek-ai/dsh-objective-synthesizer'
  config:
    provider: spawn
```

`provider` 命名运行综述 child 的已注册 `ctx.subagents` 提供方;默认 `spawn` 对应自带的 spawn-in-process 后端。

## Delegation contract

`synthesizeObjective(ctx, provider, parent, objectiveId, signal)` 读取目标,为每个成员会话收集一个材料块(经 `ctx.sessionQuery.readSession` 取尾部三条 assistant 文本消息,每条上限 2000 字符),并以 `maxDepth: 0` 启动一个 child——综述 child 不能再委派,该 pass 只做 fan-in。child 必须返回 `{ brief, openQuestions }`;存储的 brief 由该段落加非空白待决问题渲染。无成员会话、child 未以 `stopReason: 'completed'` 结束、或结构化结果缺失/畸形,都以稳定的 `ObjectiveSynthesisError` 码拒绝;基础设施故障原样重抛。run 总会被 dispose。

本包注册同一路径上的 `/synthesize <objective id>` 人类命令:解析 id 片段、以发令 agent 为锚运行委派、打印存储的 brief。

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

- **仅命令触发** — 自动触发(目标有动静、分诊窗口)等待调度消费者;委派路径已导出供其使用。
- **尾部消息材料** — brief 只见每个成员最后三条 assistant 消息;更早的结论只能经感知 compaction 的收集器触达。
- **运行间不缓存** — 每次 `/synthesize` 都重读全部成员日志;增量综述等待事件驱动的材料收集器。
