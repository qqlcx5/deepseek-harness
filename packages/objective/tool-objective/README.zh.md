# @deepseek-ai/dsh-tool-objective

[English](README.md) | 中文

带执行期权限校验的模型侧跨会话目标工具:`list_objectives`、`get_objective`、`create_objective`、`attach_objective`,基于 [`ctx.objectives`](../objective)。设计理由见 [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md)。

## Tool contract

四个工具均为 exclusive、Codex 形制、返回紧凑 JSON。`list_objectives` 与 `get_objective` 是读操作,任意调用 agent 在其活跃驱动内可用;`create_objective` 与 `attach_objective` 额外要求顶层 agent 上的直接人类轮(当前开放轮内经宿主认证的 `user` 来源),因此被委派的子 agent 不能自行创建意图容器或声明归属。工具在 order 117 贡献 `tool:objective` 系统提示段,承载共享策略文本。

读操作呈现缓存的综述 brief(含时间戳),模型无需重读成员会话即可回答"这个意图进展如何";brief 只通过这些工具结果或消费者的被记录 inject 到达模型,绝不静默注入。写操作与注册表服务一一对应:create 经服务自身的拒绝码校验;attach 记录当前会话并在其上镜像 log-only 的 `objective/member` 事件。

## Extension points

部署工具无需改动本包;权限策略位于 `authority.ts`,与 `dsh-tool-goal` 镜像同构。单独发布的 `./invariant` companion 运行时不注册任何内容(无独立状态或事件协议)。

## Model Experience

### Objective tools

#### What the model sees

Four tool schemas ([tool catalog](../../../docs/tool-catalog.md)) plus the `tool:objective` system-prompt section while the tools are composed. Tool results are compact JSON: list rows carry id/title/status/memberCount/hasNorthStar/hasBrief; detail values add the north-star statement, the brief with its stamp, and the member session ids.

#### Token effect

One fixed guidance section per request while composed, plus each tool call's own result. No other request tokens.

#### KV Cache effect

The guidance section is a stable repeated prefix. Tool calls and results append; nothing replaces earlier request tokens. Unmounting the plugin removes the section and invalidates one prompt-section boundary.

## Known Limitations and Deferred Work

- **无 update/detach/delete 工具** — 状态变更、移除归属与删除属于人类命令面(命令消费者拥有);模型只能创建与挂载。
- **不写 brief** — `setBrief` 属于 subagent 缝上的综述消费者,不属于模型自身的工具调用。
- **读操作需要开放轮** — 共享的执行检查拒绝驱动轮之外的读;后台读面等待具体消费者。
- **权限与 `dsh-tool-goal` 镜像** — 执行/直接人类检查是领域拷贝而非共享包;出现第三个消费者时再抽取。
