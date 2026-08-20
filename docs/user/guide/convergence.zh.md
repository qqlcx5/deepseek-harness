# 使用收敛层

[English](convergence.md) | 中文

收敛层给运行中的 harness 增加两个跨会话能力：**目标(Objective)**——比任何单个会话都长寿的持久意图，各带一份 AI 综述缓存；**决策(Decision)**——你自己的战略决断作为一等对象，带选项、反证段、冻结的置信度和校准轨迹。全部以插件交付，核心零改动。第三层(断言、矛盾检测、记忆晋升)已设计、尚未实现。

## 挂载(一次性)

把下面这些行加进 profile 的 `cordis.patch.yml`(或新建组合)。也可以直接抄现成参考:`examples/headless-agent/objective.cordis.yml`。

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: objective
  name: '@deepseek-ai/dsh-objective'
- id: tool-objective
  name: '@deepseek-ai/dsh-tool-objective'
- id: command-objective
  name: '@deepseek-ai/dsh-command-objective'
  config:
    maxActiveObjectives: 4
- id: session-query
  name: '@deepseek-ai/dsh-session-query'
- id: decision
  name: '@deepseek-ai/dsh-decision'
- id: command-decision
  name: '@deepseek-ai/dsh-command-decision'
```

AI 两个通道(综述与起草)额外需要组合里有 `dsh-subagent`、可用的 `DEEPSEEK_API_KEY`,以及:

```yaml
- id: objective-synthesizer
  name: '@deepseek-ai/dsh-objective-synthesizer'
  config:
    provider: spawn
    materialTail: 3
    messageCapChars: 2000
- id: decision-drafter
  name: '@deepseek-ai/dsh-decision-drafter'
```

删掉一行即卸载该插件，其余照跑。每个插件的 `inject` 在启动时校验——缺依赖会以 pending 插件大声报出，绝不静默半残。

## 管目标:`/objective`

在任何支持命令的输入框(Web UI 输入框)里敲:

| 命令 | 效果 |
|---|---|
| `/objective` | 总览:`[A/P/C]` 行、成员数、`Active: n/上限`、超限警告 |
| `/objective <标题>` | 创建 active 目标 |
| `/objective attach <id>` | 把当前会话挂入(id 取任意唯一片段) |
| `/objective detach <id>` | 把当前会话移出 |
| `/objective park <id>` | 挂起:不收新成员、综述跳过、仍占上限名额 |
| `/objective reopen <id>` / `close <id>` | 重开 / 关闭 |
| `/objective brief <id>` | 显示综述缓存及时间戳 |
| `/objective delete <id>` | 删除记录；会话日志不动 |

attach 与 detach 幂等；parked 和 closed 目标拒绝新成员。

## 综述一个目标:`/synthesize`

```
/synthesize <id>
```

一次 fan-in:读取每个成员会话的尾部结论(默认三条、每条 2000 字符，可配)，启动一个不能再委派的一次性子代理,把"一段结论 + 至多三个待决问题"存为目标 brief。并发运行有栅栏——后写者以 `OBJECTIVE_STALE_BRIEF` 拒绝,不会静默覆盖。

## 决策:`/decide`

| 命令 | 效果 |
|---|---|
| `/decide` | 总览:`[O/D/S]` 行 + 到期未回访提醒 |
| `/decide <问题>` | 创建 open 决策 |
| `/decide show <id>` | 完整卡片:选项(证据/代价/风险)、推荐+置信、**反证段永远渲染** |
| `/decide choose <id> <选项>` | 拍板;置信度快照在此冻结 |
| `/decide choose <id> <选项> confirm <stamp>` | 不可逆路径:第一遍返回反证段与 stamp,只有 confirm 行才生效；卡变过则 stamp 失效 |
| `/decide rev <id> <结果>` | 对冻结预测记一句话结果 |
| `/decide super <id>` / `delete <id>` | 作废(留痕)/ 删除(回访行保留) |

行上的 `(!)` 标记 = 该决策的目标链接悬空或目标已挂起。

## AI 起草:`/decide-draft`

```
/decide-draft <decision id> [objective id]
```

读取问题 + 目标的 brief 与成员结论,委派一个一次性子代理,把整张草稿卡(选项、推荐、置信、可逆性建议、反证段)经注册表写回。它绝不替你拍板;输出会给出继续所需的 `/decide show` 与 `/decide choose` 确切命令行。

## 模型自己能做什么

组合了 `dsh-tool-objective` 后，模型可调 `list_objectives`、`get_objective` 从 brief 回答"目标进展如何",而 `create_objective` / `attach_objective` 只在人类直接提问的轮次可用——被委派的子代理无权建目标或认领归属。决策层的模型工具尚未提供。

## 实践中的一周

```
Mon  /objective stabilize rulelift      → create
     /objective attach <id>             → current session joins
     (parallel audit sessions, each attaches)
Wed  /synthesize <id>                   → six audits become one paragraph + 3 questions
     /decide repair or rewrite?         → open
     /decide-draft <did> <oid>          → AI drafts the card with counter-evidence
     /decide show <did>                 → human reads, then chooses
+3w  /decide                            → due-for-review reminder fires
     /decide rev <did> <outcome>        → calibration trail grows
```

(周一建目标并挂入审计会话；周三综述、开决策、AI 起草、人读卡拍板；三周后到期提醒出现，一句话回访。)

## 数据与排错

所有记录落在 `$DSH_HOME/storages/` 下可读的 JSON;备份即拷贝该目录。启动时一致性校验 fail-loud——报 `inconsistent` 即顺序表与记录漂移。AI 通道报 provider 错误 = 组合缺 `dsh-subagent` 或 `provider` 名不匹配(默认 `spawn`)。

## 尚未实现

矛盾检测、断言抽取、记忆晋升(知识层)、校准报告展示面、定时回访推送、自动目标归属,均已在[convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) 中设计,后续阶段落地。
