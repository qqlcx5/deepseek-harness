# @deepseek-ai/dsh-knowledge

[English](README.md) | 中文

跨会话断言注册表:带来源的原子命题及其边图——`supports`、`refines`、`supersedes`、`contradicts`。取代与冲突是边,不是状态:被取代的断言带着完整轨迹保持可读。晋升要求来自不同证据源的交叉印证,且以规范化文档粒度判定相异——共享同一份上游产物的并行审计永远不会被算成两次。设计理由见 [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md)。

## Service contract

`ctx.claims` 提供 create、get、list、listActive、link、edgesOf、promote、retire 与 delete。创建时来源必填(已知的 `sourceKind` 加非空 `sourceUri`);置信度是 [0, 1] 内的有限数;`validUntil` 是复核日期,不是到期删除。所有变更在串行写链上执行,且只在持久写入成功后发布 `claim/changed`。启动时校验注册表顺序与 claims 表完全一致。

`link` 对每个有序对写一条关系——重连同一对会替换其关系——并拒绝自环与未知端点。边在所提名的断言被删除后保留:提名缺席断言的边是惰性数据,不是损坏。`canonicalDocumentUri` 去掉片段与行锚;`promote` 把断言自身来源与补充的印证位置归并到文档根:少于两个相异根以 `CLAIM_INVALID_CORROBORATION` 拒绝。已晋升断言不可变(retire 即降级);仅 active 断言可晋升。

## Extension points

消费者在持久提交后响应 `claim/changed`。哨兵消费者在有界比对集(同目标、已晋升、被决策引用)内对新断言做三分类:`contradicts`(告警并附双方来源)、`refines`(条件性差异——记边,不告警)、无冲突;裁决经 `link` 写边。抽取体创建的断言,其来源必须解析到 session log 记录。单独发布的 `./invariant` companion 运行时不注册任何内容。

## Model Experience

None, as this package registers no model-visible input: claims are cross-session domain data, and nothing here enters prompt, tool schema, or session event. A consumer that surfaces claims to a model owns its own model experience.

#### KV Cache effect

The package contributes no model request content, so an existing request prefix stays reusable.

## Known Limitations and Deferred Work

- **尚无决策链接** — 决策证据字段仍是自由文本;把引用转换为 claim id(并在被引用断言被取代时标记决策待复核)的回填随哨兵消费者落地。
- **原子性是抽取体的职责** — 注册表原样存储命题;判断一条命题是否原子、是否值得去重是消费者事务(同一事实的两种措辞在消费者连接它们之前就是两条断言)。
- **边不排序** — 边表按对为键,不参与顺序;列举顺序为底层单元的插入序。
- **晋升目的地是抽象的** — `promoted` 是持久状态; 导出到部署记忆面等待具体的记忆消费者。
