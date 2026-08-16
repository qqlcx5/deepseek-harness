# @deepseek-ai/dsh-tool-objective

English | [中文](README.zh.md)

Model-facing cross-session objective tools with execution-time authority checks: `list_objectives`, `get_objective`, `create_objective`, and `attach_objective` over [`ctx.objectives`](../objective). The [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) owns the design rationale.

## Tool contract

All four tools are exclusive, Codex-shaped, and return compact JSON. `list_objectives` and `get_objective` are reads for any calling agent inside its active driver; `create_objective` and `attach_objective` additionally require a direct human turn on a top-level agent (host-attested `user` source in the current open turn), so delegated children cannot create intent containers or claim membership on their own. The tools contribute the `tool:objective` system-prompt section at order 117 with the shared policy text.

Reads surface the cached synthesis brief (with its timestamp) so a model answers "where does this intent stand" without re-reading member sessions; the brief reaches a model only through these tool results or a consumer's logged inject, never silently. Writes map one-to-one onto the registry service: create validates through the domain's own rejection codes, attach records the current session and mirrors the log-only `objective/member` event on it.

## Extension points

Deployment tools change nothing here; authority policy lives in `authority.ts` and mirrors `dsh-tool-goal`. The separately published `./invariant` companion registers nothing at runtime (no independent state or event protocol).

## Model Experience

### Objective tools

#### What the model sees

Four tool schemas ([tool catalog](../../../docs/tool-catalog.md)) plus the `tool:objective` system-prompt section while the tools are composed. Tool results are compact JSON: list rows carry id/title/status/memberCount/hasNorthStar/hasBrief; detail values add the north-star statement, the brief with its stamp, and the member session ids.

#### Token effect

One fixed guidance section per request while composed, plus each tool call's own result. No other request tokens.

#### KV Cache effect

The guidance section is a stable repeated prefix. Tool calls and results append; nothing replaces earlier request tokens. Unmounting the plugin removes the section and invalidates one prompt-section boundary.

## Known Limitations and Deferred Work

- **No update, detach, or delete tools** — status changes, membership removal, and deletion are human-command surface (the command consumer owns them); the model may only create and attach.
- **No brief writing** — `setBrief` belongs to a synthesis consumer over the subagent seam, not to the model's own tool calls.
- **Reads require an open turn** — the shared execution check rejects reads outside a driver turn; a background read surface awaits a concrete consumer.
- **Authority mirrors `dsh-tool-goal`** — the execution/direct-human checks are domain copies rather than a shared package; extraction waits for a third consumer.
