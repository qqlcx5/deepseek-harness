# @deepseek-ai/dsh-decision

[English](README.md) | 中文

跨会话战略决策注册表。该服务把持久决策作为一等对象——问题、带证据与代价的选项卡、带理由与置信度的推荐、必填的反证段、可逆性分诊——外加"决定时预测 vs 一句话实际结果"的校准轨迹。设计理由见 [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md)。

证据引用先采用自由文本;claim-id 回填随知识层到来。决策不属于任何会话:它是 [storage domain form](../../storage/storage-domain/README.md) 上的跨会话状态,可选地关联 objective;其回访轨迹比被度量的决策和讨论过它的会话都活得久。

## Service contract

`ctx.decisions` 提供 create、get、list、listOpen、update、decide、supersede、recordReview、reviewsOf 与 delete。所有变更在串行写链上执行,且只在持久写入成功后发布 `decision/changed`。启动时校验注册表顺序与 decisions 表完全一致,任何分歧都立即失败。

每个决策以 `open` 状态创建,反证段为空串;草稿更新(问题、选项、反证、推荐、理由、置信度、可逆性、到期时间)仅对 open 决策合法——已决定或被取代的决策是历史。`decide` 在选项卡非空时校验所选 label 必须在卡上,冻结 `predictedConfidence`(显式覆盖值,否则用草稿置信度)并盖 `decidedAt`。不可逆决策要求 `confirm: true`——第一遍以 `DECISION_IRREVERSIBLE_CONFIRM` 拒绝,促使调用面引用当前反证段后再走第二遍;`expectedUpdatedAt` 栅栏在读卡人读卡之后卡被改动时以 `DECISION_STALE_CARD` 拒绝,批准一张人没看过的卡因此不可能。`recordReview` 基于冻结的预测追加一行校准记录,把决策的目标快照到该行,且在被度量的决策删除后保留。`reviewsByObjective` 按目标聚合轨迹、旧者在前——校准读的是一个主题,不是一张卡;无链接决策的回访不进任何聚合。选项 label 在单个决策内唯一且非空;置信度是 [0, 1] 内的有限数。

反证字段作为字段是必填的:可以为空,不能缺席——设置议程的面必须同时携带它所知道的对自己不利的证据。强制执行在持久边界(domain schema 没有缺席形态)与渲染决策卡的消费面上。

## Extension points

消费者在持久提交后响应 `decision/changed`。起草消费者经 `update` 填卡,绝不写 `decided`——拍板是人类交互,不是自动写入。回访面经 `reviewsOf` 读校准轨迹。单独发布的 `./invariant` companion 运行时不注册任何内容。

## Model Experience

None, as this package registers no model-visible input: decisions are cross-session domain data, and nothing here enters prompt, tool schema, or session event. A consumer that surfaces a decision card to a model owns its own model experience.

#### KV Cache effect

The package contributes no model request content, so an existing request prefix stays reusable.

## Known Limitations and Deferred Work

- **无自动回访投递** — `dueAt` 是持久字段,到期决策经列表视图呈现;搭载 schedule 缝需要跨会话决策目前没有的会话锚点。命令面改为列出到期未回访决策。
- **校准只有存储** — 长周期校准报告(按 Agent Note,至少 100 条回访后才报告)尚无消费者;`reviewsOf` 与 `reviewsByObjective` 是原始轨迹。
- **回访无限制** — `recordReview` 没有速率约束;失控消费者可追加重复结果行污染轨迹(读取端去重未实现)。
- **不可逆门是流程性的,不是认知性的** — `confirm: true` 证明发生了第二遍,不证明人读了反证段;语义检查留在渲染面与抽查审计。
- **无 claim 链接** — 证据按设计是自由文本,直到知识层落地;回填把引用转为 claim id,不改动本注册表。
- **回访比决策活得久** — 删除决策按设计保留其回访行(校准历史);需要联查的列表以 `decisionId` 对缺席记录过滤。
