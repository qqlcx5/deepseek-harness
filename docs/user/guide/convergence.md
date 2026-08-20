# Use the convergence layer

English | [中文](convergence.zh.md)

The convergence layer adds two cross-session concerns to a running harness: **objectives** (durable goals that outlive any one session, each with a cached AI synthesis) and **decisions** (your own strategic calls as first-class objects with options, counter-evidence, a frozen confidence, and a calibration trail). Everything ships as plugins; nothing is built into the core. A third layer (claims, contradiction detection, memory promotion) is designed but not yet built.

## Mount it once

Add these rows to your profile's `cordis.patch.yml` (or a fresh composition). Copy a working reference from `examples/headless-agent/objective.cordis.yml` if you prefer.

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

The AI passes (synthesis and drafting) additionally need `dsh-subagent` in the composition, a working `DEEPSEEK_API_KEY`, and:

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

Removing a row unloads that plugin; the rest keeps running. Every plugin's `inject` list is checked at boot — a missing dependency is reported loudly as a pending plugin, never a silent half-feature.

## Manage objectives: `/objective`

Type these in any command-capable input (the Web UI composer):

| Command | Effect |
|---|---|
| `/objective` | Overview: `[A/P/C]` rows, member counts, `Active: n/cap`, over-cap warning |
| `/objective <title>` | Create an active objective |
| `/objective attach <id>` | Attach the current session (any unique id fragment) |
| `/objective detach <id>` | Remove the current session |
| `/objective park <id>` | Park: no new members, synthesis skips it, still counts against the cap |
| `/objective reopen <id>` / `close <id>` | Reopen or close |
| `/objective brief <id>` | Show the cached synthesis with its timestamp |
| `/objective delete <id>` | Delete the record; session logs stay untouched |

Attach and detach are idempotent; parked and closed objectives reject new members.

## Synthesize an objective: `/synthesize`

```
/synthesize <id>
```

One fan-in pass: the plugin reads each member session's trailing conclusions (three messages, 2000 characters each, configurable), starts one single-shot child that cannot delegate further, and stores one paragraph plus up to three open questions as the objective's brief. Concurrent runs are fenced — the later writer rejects with `OBJECTIVE_STALE_BRIEF` instead of overwriting.

## Decide: `/decide`

| Command | Effect |
|---|---|
| `/decide` | Overview with `[O/D/S]` rows and a due-for-review reminder |
| `/decide <question>` | Create an open decision |
| `/decide show <id>` | Full card: options with evidence, cost, risk; recommendation with confidence; **the counter-evidence section always renders** |
| `/decide choose <id> <option>` | Decide; the confidence snapshot freezes here |
| `/decide choose <id> <option> confirm <stamp>` | The irreversible path: the first attempt returns the counter-evidence and a stamp; only the confirm line decides, and a changed card invalidates the stamp |
| `/decide rev <id> <outcome>` | Record a one-line outcome against the frozen prediction |
| `/decide super <id>` / `delete <id>` | Supersede (kept for the trail) / delete (review rows survive) |

A `(!)` marker on a row means its objective link dangles or the objective is parked.

## Draft a card with AI: `/decide-draft`

```
/decide-draft <decision id> [objective id]
```

Reads the question plus the objective's brief and member conclusions, delegates one single-shot child, and writes the drafted card — options, recommendation, confidence, reversibility suggestion, and the counter-evidence section — back through the registry. It never decides for you; its output names the exact `/decide show` and `/decide choose` lines to continue.

## What the model can do on its own

With `dsh-tool-objective` composed, the model may call `list_objectives` and `get_objective` to answer "where does this goal stand" from the brief, and `create_objective` / `attach_objective` only inside a direct human turn — delegated children cannot create objectives or claim membership. Decision tools for the model are not built yet.

## A week in practice

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

## Data and troubleshooting

All records live under `$DSH_HOME/storages/` as readable JSON; backing up means copying that directory. Boot-time consistency checks fail loud — an `inconsistent` error means the stored order and records diverged. A provider error from the AI passes means `dsh-subagent` is missing or the `provider` name does not match (default `spawn`).

## Not built yet

Contradiction detection, claim extraction, memory promotion (the knowledge layer), the calibration report surface, scheduled review pushes, and automatic objective attribution are designed in the [convergence-layers Agent Note](../../../.agents/notes/proposed/architecture/2026-08-16-agentdeck-convergence-layers.md) and land in later phases.
