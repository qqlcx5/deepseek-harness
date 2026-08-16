# Agent Note:收敛层 —— Objective、Claim、Decision

Status: proposed

[English](2026-08-16-agentdeck-convergence-layers.md) | 中文

## Problem

并行 agent 产出的结论,harness 只将其记录为 session,再无下文。由此产生三个缺口,均在真实多 agent 使用中观察到:

1. **意图散落。** 一个用户目标横跨多天、多个 session。[ `ctx.goals`](../../implemented/feature/2026-07-19-persisted-same-session-goal-domain.md) 只跟踪单个 session 内的目标;`ctx.workspaceRegistry` 只按目录分组 session。没有任何机制回答"服务于此目标的全部 session 合计得出了什么结论、还有什么悬而未决"。
2. **知识碎裂。** 一份审计的结论留在某个 session log 里,相关记忆留在另一个里,没有去重、链接、矛盾检测或时效。后续 agent 复用已被取代的结论,因为没有机制发现冲突。
3. **决策无痕。** 用户自己的战略决策——修复还是重写、先做哪个 P0——发生在聊天里,从不是一等对象,事后无法复盘或校准。

来源设计是 AgentDeck v2.0,一份用户提供的个人 agent 注意力与收敛产品设计稿。它规定了下述三层(Objective、Claim、Decision)、六个"meta-agent"整合角色,和一条总纲:只有当一次委派能减少人必须亲自阅读的信息量时,它才是正当的。本 note 拥有 harness 侧的映射;产品动机归外部文档所有。

## Proposal

三个能力缝,每层一个,均通过 [storage domain form](2026-07-24-domain-kv-storage-and-workspace.md) 持久化,均可独立上线。每个包组沿用 `goal/` 的分解范式:Service Definition 包、模型工具包、人类命令包。

| 层 | 包组 | Domain 表 | Meta-agent(Consumer) |
|---|---|---|---|
| Objective | `packages/objective/` | `objective`、`objective_member` | 综述体、归属体 |
| Knowledge | `packages/knowledge/` | `claim`、`claim_edge` | 抽取体、哨兵 |
| Decision | `packages/decision/` | `decision`、`decision_review` | 起草体、回访体 |

### Phase A —— Objective(意图层)

- `ObjectiveId` 为 branded id。`objective` 表记录标题、北极星陈述、状态(`active`/`parked`/`closed`)、缓存的目标级综述及其时间戳;`objective_member` 记录 session↔objective 的多对多归属。
- 归属写两处:一条 domain 行,加一条成员 session 上的 log-only `objective/member` session 事件(沿用 `subagent/descriptor` 的 log-only 模式),因此单凭一个 session 的 log 就能冷读出它的目标归属。
- 归属默认 AI 提议、人确认:meta-agent 依据 `SessionHeader.cwd`、首条提示词、既有目标标题提议归属(先例:session-title LLM providers);人通过命令确认或纠正。未归属的 session 汇入显式的"未分配"视图;未归属率是健康信号,不是硬门槛。
- 目标级综述由一个带 output schema 的 one-shot subagent 产出(一段当前结论 + 至多三个待决问题),经 session-query 缝读取成员 session,写回 `objective.brief`。它只能通过 `agent.inject()` 到达模型,注入文本因此被记录;绝不静默拼进请求。
- WIP 上限是经校验的 config 字段(命令面上的软信号),遵循可配置部署参数的规则。

### Phase B —— Knowledge(断言层)

- `ClaimId` 为 branded id。一条 claim 是一个原子断言,加来源(`sourceKind`、`sourceUri`、`sourceSession` 及事件锚点)、置信度、`validUntil`、状态(`active`/`retired`/`promoted`;被取代是边,不是状态)。`claim_edge` 以 claim 对为键,关系为 `supports`/`refines`/`supersedes`/`contradicts`。
- 抽取体监听 `subagent/end` 与末条长 assistant 消息,委派一个带 claim output schema 的 one-shot subagent 抽取,落库的 claim 其来源必须解析到产生它的 session log 记录。
- 哨兵在 claim 写入时运行:one-shot subagent 将新 claim 与既有 claims 比对,产出"无冲突"或一份指名双方来源的冲突报告。报告在命令面发出非阻断告警;人的裁决写入 `supersedes` 或 `contradicts` 边,并退役或确认受影响的 claims。
- 晋升将一条被交叉印证的 claim 导出到部署的持久记忆面;过期的 `validUntil` 将该 claim 降级为待复核。两者都是人确认的动作。

### Phase C —— Decision(决策层)

- `DecisionId` 为 branded id。一条 decision 记录问题、选项(各带引用的 claim id、代价、风险)、含理由的推荐、置信度、可逆性(`reversible`/`costly`/`irreversible`)、状态(`open`/`decided`/`superseded`)、所选选项、决定/到期时间戳。`decision_review` 记录预测置信度与一句话实际结果的对照。
- 起草体将相关 claims 聚成一张决策卡草稿(one-shot subagent,output schema)。人通过 user-questions 缝批准、修改或否决;批准是一次用户交互,绝不是自动写入。
- 可逆性分诊审批路径:可逆选项走快路径(看卡即批);不可逆选项必须先在同一交互中打开被引用 claims 的来源,批准选项才出现。
- 回访搭载 schedule 缝:到期的 decision 产生一次低摩擦跟进("结果如何?一句话或选项即可")。预测与实际的对照累积为校准视图。哨兵取代某条已被 decided decision 引用的 claim 时,该 decision 被标记待复核。

### 委派规则

每个 meta-agent 都通过既有的 [subagent 缝](../../implemented/feature/2026-06-21-subagent-capability-seam.md) 以带 `outputSchema` 和 persona 的 one-shot child 运行,且只允许 fan-in:该次运行必须减少人必须亲自阅读的信息量。不做工具间的多步流水线,不做业务自动化。各层的包组自带其 meta-agent 接线;共享委派宿主的抽取推迟到"触发→委派→回写"序列被证实重复之时。

本提案消费 [storage domain form](2026-07-24-domain-kv-storage-and-workspace.md) 与 subagent、session-query、user-questions、schedule、commands 缝;不取代其中任何一个,除 log-only 的 `objective/member` 外不扩展 session event map,不改 agent loop。

## Alternatives considered

**把 `ctx.goals` 扩展为跨 session 目标。** 否决:goal 状态由单个 session log 事件溯源,跨 session 注册表会破坏单 log 折叠,同时把单会话执行目标与长生命周期意图容器混为一谈。goal 仍是一个 session 的执行视图;objective 引用 session,可以引用某 session 的 goal,但不拥有它。

**只按 workspace 分组。** 否决:workspace 按目录,objective 按意图;一个 session 可服务多个目标,一个目标可跨目录。两者是同一批 session 上的正交记录。

**用 Markdown 文件而非 domain。** 否决:矛盾检测与证据链接需要结构化查询和类型化 id;storage domain 是跨 session 类型化状态的既有缝,并免费获得后端可换性。

**单一 meta-agent 宿主包。** 推迟:三个组各自接线的重复是轻微的;等序列真正重复时再抽取宿主包,不提前。

**Continuable 常驻 meta-agent。** 推迟:带结构化输出的 one-shot child 覆盖全部六个角色;常驻引入 Activation 归属与拆除面,当前没有需求。

## Acceptance criteria

- 每个 phase 以完整能力缝落地(Service Definition、storage-domain 表、至少一个模型或人类面向的 Consumer),并可在 profile 中独立组合。
- Objective 归属单凭成员 session log 即可恢复;综述只能通过被记录的 inject 到达模型。
- 每条 claim、告警、决策卡都携带可解析到 session log 记录的来源;告警同时渲染冲突双方来源。
- 哨兵告警绝不阻断 claim 写入;裁决以边的形式记录。
- 不可逆 decision 在交互面呈现被引用证据之前无法被批准。
- 每个 phase 有一份 keyless 组装快照(带综述的多 session objective;被抽取的 claim 含一次被发现并裁决的矛盾;经交互缝批准的起草决策),按测试政策通过真实可运行示例产生。
- 不改 agent loop;一切行为挂在文档化扩展点上。

## Risks

- **结构化负担。** 若要求人填字段,就会重演这些层本要消除的碎裂。因此归属、抽取、起草默认 AI 提议、人确认;手动录入是兜底。
- **收敛失真传入决策。** 没有来源链接,错误的摘要或 claim 不可见。每个派生产物携带来源链接、不可逆审批强制阅读来源、哨兵捕获知识层冲突;这是缓解,不是保证。
- **哨兵噪声。** 误报侵蚀信任并被静音。告警只建议不阻断,裁决是一个手势,裁决结果回调检测阈值。
- **向通用工作流平台蔓延。** 上文的委派规则就是守卫:一个无法论证"减少了人的直接阅读量"的 meta-agent 提案即出局,且该判定记录在评审中,不留给运行时判断。
