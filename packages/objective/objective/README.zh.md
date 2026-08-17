# @deepseek-ai/dsh-objective

[English](README.md) | 中文

跨会话目标注册表。该服务在 [storage domain form](../../storage/storage-domain/README.md) 之上持有持久的北极星记录——比任何一个会话都长寿的意图容器——以及有序的成员会话账本。设计理由见 [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md)。

objective 与 workspace 正交:workspace 按目录记录归属,objective 按意图记录归属,一个会话可服务多个目标。同会话执行目标属于 `ctx.goals`;一个 objective 可以引用某会话的 goal,但不拥有它。

## Service contract

`ctx.objectives` 提供 create、get、list、update、attachSession、detachSession、objectivesOf、setBrief 与 delete。所有变更在串行写链上执行,且只在持久写入成功后发布 `objective/changed`。启动时校验注册表顺序与记录表完全一致,任何分歧都立即失败。

状态转换不受限——close 不是终态,重开 objective 是受支持的流程。成员账本新者在前;attach 与 detach 幂等。**新归属要求目标处于 active**:parked 目标不收新成员(它是 WIP 手柄,且仍计入上限),closed 目标须先重开;已入账成员在幂等路径上始终可解析。归属先写 domain:domain 是归属权威。存活的成员会话额外收到一条 log-only 的 `objective/member` session 事件(按目标,最后一个动作胜出;`foldObjectiveMembership(events)` 折叠单个会话的有效归属);该事件写入失败只记日志,绝不回滚 domain 写入。既不存活也未持久化的会话只在 domain 上挂载。

brief 是缓存的综述产出(`setBrief` 同时盖 `briefAt` 时间戳);它是数据,不是调度。可选的第三参数以 compare-and-set 方式拦截并发写者:调用方传入它读到的 `briefAt`(无 brief 时传 `null`),不匹配——期间另一写者已存入 brief——则以 `OBJECTIVE_STALE_BRIEF` 拒绝,而非静默覆盖。单独发布的 `./invariant` companion 在畸形 `objective/member` 载荷进入持久日志之前拒绝它。

## Extension points

消费者在持久提交后响应 `objective/changed`。综述消费者经查询缝读取成员会话、经 `setBrief` 写回 brief、且只通过被记录的 inject 将其送入成员会话。归属消费者提议 `attachSession`/`detachSession`;人的确认面属于消费者。

## Model Experience

None, as this package writes no model-visible input: the log-only `objective/member` event and the domain brief never enter model context. A consumer injecting the brief through `agent.inject()` owns its own model experience.

#### KV Cache effect

The package contributes no model request content, so it cannot invalidate an existing request prefix. The `objective/member` event appends to the session log outside the ordered surface and never appears in a derived model history.

## Known Limitations and Deferred Work

- **WIP 上限推迟** — 最大活跃目标数的信号需要其命令面消费者;没有消费者的 config 字段不进入本包。
- **尽力而为的日志镜像** — 非存活会话的归属只落在 domain 上;镜像事件追加失败时该会话日志缺少此边。domain 仍是权威,该会话的冷读不显示归属。
- **归属要求 active 状态** — parked 与 closed 目标按设计拒绝新成员(WIP 手柄);同一规则不约束其他操作:detach、brief 与 delete 在任何状态下可用。
- **删除的崩溃窗口** — 顺序写入与记录删除之间崩溃会留下孤儿记录,下次启动会大声失败;恢复需人工修复介质。
- **无 RPC 面** — 该服务仅限宿主侧;Typert 导出与 client projection 等待具体的远程消费者。
- **信任同进程生产者** — 拥有直接 `Session` 访问的插件能追加格式合法的伪造 `objective/member` 事件。invariant companion 检测畸形载荷;格式合法的伪造属于完整性检测,不是插件隔离。
