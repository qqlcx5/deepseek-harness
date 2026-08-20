# @deepseek-ai/dsh-command-decision

[English](README.md) | 中文

跨会话决策注册表的人类命令 `/decide`:列出、创建、渲染带反证段的决策卡、选择选项、记录回访结果、取代或删除。已决定且过了回访日期但尚无回访的决策以到期提醒呈现,校准轨迹不至荒废。设计理由见 [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md)。

## Command grammar

`/decide` 不带参数列出全部决策(`[O]`/`[D]`/`[S]` 标志、已决定行显示所选选项、短 id 片段)加到期提醒与用法。裸的非关键字输入创建 open 决策。`show <id>` 渲染完整卡片——带证据/代价/风险的选项、带置信度的推荐、**始终渲染的反证段**(空段显式说明;缺席从不静默)、决定后的所选选项与冻结预测、可逆性。`choose <id> <option>` 经注册表的卡片校验拍板;`rev <id> <outcome>` 基于冻结预测记录校准行;`super <id>` 与 `delete <id>` 收尾(删除保留回访轨迹)。id 片段在稳定 id 内任意位置匹配;歧义片段列出命中并要求更多字符。

领域拒绝以一条稳定的错误行呈现并指回 `/decide`;注册表仍是唯一写入方。本命令不注册任何模型可见面。

## Model Experience

None, as this package registers no model-visible input: it contributes one human command and its output text, and the model neither sees nor invokes it. A command adapter that logs the exchange into a session owns its own model experience.

#### KV Cache effect

No model request content is contributed, so an existing request prefix stays reusable. The command lifecycle events append to the session log outside the ordered surface.

## Known Limitations and Deferred Work

- **命令不填卡** — `/decide` 创建问题并拍板;填选项卡、推荐与反证走注册表服务(起草消费者将其自动化),不进命令子语法。
- **提醒只拉不推** — 到期提醒只在总览渲染;定时推送等待跨会话决策的会话锚点。
- **片段匹配是子串** — 命中多个决策的短片段被拒绝而非交互消歧。
