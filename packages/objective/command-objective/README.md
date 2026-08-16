# @deepseek-ai/dsh-command-objective

English | [中文](README.zh.md)

Human-facing `/objective` command over the cross-session objective registry: list, create, attach or detach the commanding session, park, reopen, close, delete, and show the recorded brief. The [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) owns the design rationale.

## Config

```yaml
- id: command-objective
  name: '@deepseek-ai/dsh-command-objective'
  config:
    maxActiveObjectives: 4
```

`maxActiveObjectives` must be a positive safe integer. It is a soft WIP signal: the overview always shows `Active: n/cap`, and creating or reopening past the cap adds one warning line asking the human to park or close one — creation never blocks.

## Command grammar

`/objective` alone lists every objective (`[A]`/`[P]`/`[C]` flags, member-session count, brief marker, and a short id fragment), the active count against the cap, and the usage line. A bare non-keyword input creates an objective with that title. `attach <id>` records that the commanding agent's session serves that objective (mirroring the log-only `objective/member` event); `detach <id>` removes it. `park`/`reopen`/`close` move the durable status; `delete` removes the record while member session logs stay untouched. `brief <id>` shows the cached synthesis brief with its stamp. Id fragments match anywhere in the stable id; a fragment matching several objectives names them and asks for more characters, an absent fragment says so.

Domain rejections surface as one stable error line pointing back to `/objective`; the registry remains the sole writer.

## Extension points

Command adapters dispatch through `ctx.commands`; no model-visible surface is registered. The separately published `./invariant` companion registers nothing at runtime.

## Model Experience

None, as this package registers no model-visible input: it contributes one human command and its output text, and the model neither sees nor invokes it. A command adapter that logs the exchange into a session owns its own model experience.

#### KV Cache effect

No model request content is contributed, so an existing request prefix stays reusable. The command lifecycle events append to the session log outside the ordered surface.

## Known Limitations and Deferred Work

- **No title editing or north-star editing** — `/objective` cannot rename or rewrite the north-star statement; a consumer for that surface has not appeared. Use the registry service or remove and recreate until one does.
- **Fragment matching is substring, not typed ids** — a short fragment matching many objectives is rejected rather than disambiguated interactively; the fragment length that resolves is data-dependent.
- **Commanding session only** — attach/detach always target the invoking agent's session; attributing a different session awaits an attribution consumer over the subagent seam.
