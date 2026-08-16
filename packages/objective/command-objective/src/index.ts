/**
 * Human-facing `/objective` command over the cross-session objective registry.
 * @module @deepseek-ai/dsh-command-objective
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { ObjectiveError } from '@deepseek-ai/dsh-objective'
import type { ObjectiveId, ObjectiveStatus, ObjectiveView } from '@deepseek-ai/dsh-objective'

export const name = 'command-objective'
export const inject = ['commands', 'objectives']

/** WIP signal policy: the soft cap shown and warned about by the command. */
export interface Config {
  /** Soft upper bound on concurrently active objectives; creation never blocks. */
  maxActiveObjectives?: number
}

/** Schemastery config for the objective-command WIP signal. */
export const Config: z<Config> = z.object({
  maxActiveObjectives: z.number().step(1).min(1).default(4),
})

/** Fully materialized command policy. */
interface ResolvedConfig {
  readonly maxActiveObjectives: number
}

const USAGE
  = 'Usage: /objective [<title>|attach <id>|detach <id>|park <id>|reopen <id>|close <id>|delete <id>|brief <id>]'

const ID_ACTIONS = ['attach', 'detach', 'park', 'reopen', 'close', 'delete', 'brief'] as const

type ObjectiveCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'create'; readonly title: string }
  | { readonly kind: 'member'; readonly action: 'attach' | 'detach'; readonly prefix: string }
  | { readonly kind: 'status'; readonly status: ObjectiveStatus; readonly prefix: string }
  | { readonly kind: 'delete'; readonly prefix: string }
  | { readonly kind: 'brief'; readonly prefix: string }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never, label: string): never {
  throw new TypeError(`unknown ${label}: ${String(value)}`)
}
/* v8 ignore stop */

/** Split the first word from the rest, both trimmed. */
function splitFirst(input: string): { word: string; rest: string } | undefined {
  const match = /^(\S+)\s+(.+)$/u.exec(input)
  return match === null ? undefined : { word: match[1] as string, rest: (match[2] as string).trim() }
}

/** Parse only the grammar owned by `/objective`; a lone non-keyword input is a title. */
function parseObjectiveCommand(rawInput: string): ObjectiveCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  const split = splitFirst(input)
  if (split === undefined) {
    const control = input.toLowerCase()
    if ((ID_ACTIONS as readonly string[]).includes(control)) {
      return { kind: 'invalid', reason: `/objective ${control} requires an objective id.` }
    }
    return { kind: 'create', title: input }
  }
  const { word, rest } = split
  const control = word.toLowerCase()
  if (control === 'attach' || control === 'detach') return { kind: 'member', action: control, prefix: rest }
  if (control === 'park') return { kind: 'status', status: 'parked', prefix: rest }
  if (control === 'reopen') return { kind: 'status', status: 'active', prefix: rest }
  if (control === 'close') return { kind: 'status', status: 'closed', prefix: rest }
  if (control === 'delete') return { kind: 'delete', prefix: rest }
  if (control === 'brief') return { kind: 'brief', prefix: rest }
  return { kind: 'create', title: input }
}

/** Short human-facing id reference: the stable id's trailing segment. */
function idHint(id: ObjectiveId): string {
  return String(id).slice(-8)
}

/** Resolve one id fragment against the current list: unique, ambiguous, or absent. */
function resolveByPrefix(objectives: readonly ObjectiveView[], prefix: string)
  : { kind: 'one'; objective: ObjectiveView } | { kind: 'ambiguous'; hints: string[] } | { kind: 'absent' } {
  const matches = objectives.filter(objective => prefix.length > 0 && String(objective.id).includes(prefix))
  if (matches.length === 0) return { kind: 'absent' }
  if (matches.length > 1) return { kind: 'ambiguous', hints: matches.map(objective => idHint(objective.id)) }
  return { kind: 'one', objective: matches[0] as ObjectiveView }
}

/** Human label for one durable objective status. */
function statusLabel(status: ObjectiveStatus): string {
  switch (status) {
    case 'active': return 'active'
    case 'parked': return 'parked'
    case 'closed': return 'closed'
    /* v8 ignore next 2 -- ObjectiveStatus is closed and every member is handled above */
    default: return assertNever(status, 'objective status')
  }
}

/** One list row for the show output. */
function row(objective: ObjectiveView): string {
  const flag = objective.status === 'active' ? 'A' : objective.status === 'parked' ? 'P' : 'C'
  const members = objective.sessionIds.length === 1 ? '1 session' : `${objective.sessionIds.length} sessions`
  const brief = objective.brief === undefined ? '' : ', briefed'
  return `[${flag}] ${objective.title} — ${members}${brief} · ${idHint(objective.id)}`
}

/** Render the overview: rows, the active WIP signal, and usage. */
function renderOverview(objectives: readonly ObjectiveView[], resolved: ResolvedConfig): CommandResult {
  const active = objectives.filter(objective => objective.status === 'active').length
  const warning = active > resolved.maxActiveObjectives
    ? [`Active objectives exceed the configured cap (${active}/${resolved.maxActiveObjectives}); park or close one.`]
    : []
  return {
    kind: 'success',
    text: [
      ...(objectives.length === 0 ? ['No objectives yet.'] : objectives.map(row)),
      `Active: ${active}/${resolved.maxActiveObjectives}`,
      ...warning,
      USAGE,
    ].join('\n'),
  }
}

/** Render one objective after a mutation, warning only when this objective is active over the cap. */
function renderOne(
  title: string,
  objective: ObjectiveView,
  all: readonly ObjectiveView[],
  resolved: ResolvedConfig,
): CommandResult {
  const active = all.filter(entry => entry.status === 'active').length
  const warning = objective.status === 'active' && active > resolved.maxActiveObjectives
    ? [`Active objectives exceed the configured cap (${active}/${resolved.maxActiveObjectives}); park or close one.`]
    : []
  return {
    kind: 'success',
    text: [
      title,
      `Status: ${statusLabel(objective.status)}`,
      `Objective: ${objective.title}`,
      `Members: ${objective.sessionIds.length}`,
      `Id: ${idHint(objective.id)}`,
      ...warning,
    ].join('\n'),
  }
}

/** Resolve the prefix for one id-taking command or return its error result. */
function requireObjective(
  prefix: string,
  objectives: readonly ObjectiveView[],
): { objective: ObjectiveView } | { error: CommandResult } {
  const resolved = resolveByPrefix(objectives, prefix)
  if (resolved.kind === 'absent') {
    return { error: { kind: 'error', text: `No objective id matches '${prefix}'. Run /objective to list ids.` } }
  }
  if (resolved.kind === 'ambiguous') {
    return {
      error: {
        kind: 'error',
        text: `Id '${prefix}' matches several objectives: ${resolved.hints.join(', ')}. Use more characters.`,
      },
    }
  }
  return { objective: resolved.objective }
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const cap = config.maxActiveObjectives ?? 4
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new TypeError('maxActiveObjectives must be a positive safe integer')
  }
  return { maxActiveObjectives: cap }
}

/** Execute one parsed human command through the registry that owns persistence. */
async function executeObjectiveCommand(
  ctx: Context,
  invocation: CommandInvocation,
  resolved: ResolvedConfig,
): Promise<CommandResult> {
  const command = parseObjectiveCommand(invocation.rawInput)
  const registry = ctx.objectives
  try {
    switch (command.kind) {
      case 'show':
        return renderOverview(registry.list(), resolved)
      case 'invalid':
        return { kind: 'error', text: `${command.reason}\n${USAGE}` }
      case 'create': {
        const objective = await registry.create({ title: command.title })
        return renderOne('Objective created', objective, registry.list(), resolved)
      }
      case 'member': {
        const found = requireObjective(command.prefix, registry.list())
        if ('error' in found) return found.error
        const objective = command.action === 'attach'
          ? await registry.attachSession(found.objective.id, invocation.agent.session.id)
          : await registry.detachSession(found.objective.id, invocation.agent.session.id)
        return renderOne(
          command.action === 'attach' ? 'Session attached' : 'Session detached',
          objective,
          registry.list(),
          resolved,
        )
      }
      case 'status': {
        const found = requireObjective(command.prefix, registry.list())
        if ('error' in found) return found.error
        const updated = await registry.update(found.objective.id, { status: command.status })
        return renderOne(`Objective ${statusLabel(command.status)}`, updated, registry.list(), resolved)
      }
      case 'delete': {
        const found = requireObjective(command.prefix, registry.list())
        if ('error' in found) return found.error
        await registry.delete(found.objective.id)
        return { kind: 'success', text: `Objective deleted: ${found.objective.title}` }
      }
      case 'brief': {
        const found = requireObjective(command.prefix, registry.list())
        if ('error' in found) return found.error
        return {
          kind: 'success',
          text: found.objective.brief === undefined
            ? `No brief recorded for '${found.objective.title}' yet.`
            : [
              `Brief of ${found.objective.title} (recorded ${found.objective.briefAt}):`,
              found.objective.brief,
            ].join('\n'),
        }
      }
      /* v8 ignore next 2 -- ObjectiveCommand is closed and every member is handled above */
      default: return assertNever(command, 'objective command')
    }
  } catch (error: unknown) {
    if (error instanceof ObjectiveError) {
      return {
        kind: 'error',
        text: 'The objective command is not valid for the current state. Run /objective to list objectives and ids.',
      }
    }
    throw error
  }
}

/** Register the Codex-shaped `/objective` command for every composed command adapter. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.commands.register({
    name: 'objective',
    description: 'list or manage cross-session objectives',
    input: { hint: '[<title>|attach <id>|detach <id>|park <id>|reopen <id>|close <id>|delete <id>|brief <id>]' },
    handler: invocation => executeObjectiveCommand(ctx, invocation, resolved),
  })
}
