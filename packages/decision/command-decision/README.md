# @deepseek-ai/dsh-command-decision

English | [中文](README.zh.md)

Human-facing `/decide` command over the cross-session decision registry: list decisions, create one, render the card with its counter-evidence section, choose an option, record a review outcome, and supersede or delete. Decided decisions past their review date with no review yet surface as a due-for-review reminder so the calibration trail does not rot. The [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) owns the design rationale.

## Command grammar

`/decide` alone lists every decision (`[O]`/`[D]`/`[S]` flags, chosen option on decided rows, short id fragments) plus the due-review reminder and usage. A bare non-keyword input creates an open decision. `show <id>` renders the full card — options with evidence, cost, and risk, the recommendation with its confidence, the **counter-evidence section always rendered** (an empty section says so explicitly; absence is never silent), the chosen option with its frozen prediction once decided, and reversibility. `choose <id> <option>` decides through the registry's card validation; for an irreversible decision the first pass returns the confirmation block (current counter-evidence, option evidence, and a stamp) and only `choose <id> <option> confirm <stamp>` decides — a changed card invalidates the stamp and asks for a re-read. Rows whose objective link dangles or whose objective is parked carry a `(!)` marker (silent when the objective group is not composed); `rev <id> <outcome>` records the calibration row against the frozen prediction; `super <id>` and `delete <id>` close out (deletion keeps the review trail). Id fragments match anywhere in the stable id; ambiguous fragments name their matches and ask for more characters.

Domain rejections surface as one stable error line pointing back to `/decide`; the registry remains the sole writer. The command registers no model-visible surface.

## Model Experience

None, as this package registers no model-visible input: it contributes one human command and its output text, and the model neither sees nor invokes it. A command adapter that logs the exchange into a session owns its own model experience.

#### KV Cache effect

No model request content is contributed, so an existing request prefix stays reusable. The command lifecycle events append to the session log outside the ordered surface.

## Known Limitations and Deferred Work

- **No option drafting through the command** — `/decide` creates the question and decides; filling the option card, recommendation, and counter-evidence goes through the registry service (the drafter consumer automates it) rather than command subgrammar.
- **Reminder is pull-only** — the due-review reminder renders on overview; scheduled push delivery awaits a session anchor for cross-session decisions.
- **Fragment matching is substring** — a short fragment matching many decisions is rejected rather than disambiguated interactively.
- **Evidence renders as drafted** — option evidence is free-form text until the knowledge layer backfills claim ids; the card does not verify it.
