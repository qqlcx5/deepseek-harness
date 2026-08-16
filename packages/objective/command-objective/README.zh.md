# @deepseek-ai/dsh-command-objective

[English](README.md) | 中文

跨会话目标注册表的人类命令 `/objective`:列出、创建、挂载/摘除当前会话、park、reopen、close、删除,以及显示已记录的 brief。设计理由见 [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md)。

## Config

```yaml
- id: command-objective
  name: '@deepseek-ai/dsh-command-objective'
  config:
    maxActiveObjectives: 4
```

`maxActiveObjectives` 必须是正安全整数。它是软性 WIP 信号:总览始终显示 `Active: n/cap`;超过上限时,创建或 reopen 会追加一行警告,提示人 park 或 close 一个——创建从不阻断。

## Command grammar

`/objective` 不带参数列出全部 objective(`[A]`/`[P]`/`[C]` 标志、成员会话数、brief 标记、短 id 片段)、相对上限的活跃计数与用法行。裸的非关键字输入按标题创建 objective。`attach <id>` 记录发令 agent 的会话服务于该目标(镜像 log-only 的 `objective/member` 事件);`detach <id>` 移除。`park`/`reopen`/`close` 变更持久状态;`delete` 删除记录但保留成员会话日志。`brief <id>` 显示缓存的综述 brief 及其时间戳。id 片段在稳定 id 内任意位置匹配;命中多个时列出它们并要求更多字符,无命中时如实报告。

领域拒绝以一条稳定的错误行呈现并指回 `/objective`;注册表仍是唯一写入方。

## Extension points

命令适配器经 `ctx.commands` 分发;不注册任何模型可见面。单独发布的 `./invariant` companion 运行时不注册任何内容。

## Model Experience

None, as this package registers no model-visible input: it contributes one human command and its output text, and the model neither sees nor invokes it. A command adapter that logs the exchange into a session owns its own model experience.

#### KV Cache effect

No model request content is contributed, so an existing request prefix stays reusable. The command lifecycle events append to the session log outside the ordered surface.

## Known Limitations and Deferred Work

- **不编辑标题或北极星** — `/objective` 不能改名或改写北极星陈述;该面的消费者尚未出现。出现之前用注册表服务或删除重建。
- **片段匹配是子串而非类型化 id** — 命中多个目标的短片段被拒绝而非交互消歧;能唯一定位的片段长度取决于数据。
- **仅限发令会话** — attach/detach 总是作用于发起命令的 agent 会话;归属其他会话等待 subagent 缝上的归属消费者。
