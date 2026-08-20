/**
 * Human-facing `/decide` command over the cross-session decision registry:
 * list decisions, create one, render the card with its counter-evidence,
 * choose an option, record a review, and supersede or delete. Due-unreviewed
 * decisions surface in the overview so the calibration trail does not rot.
 * @module @deepseek-ai/dsh-command-decision
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { DecisionError, DecisionId } from '@deepseek-ai/dsh-decision'
import type { DecisionView } from '@deepseek-ai/dsh-decision'

export const name = 'command-decision'
export const inject = ['commands', 'decisions']
// `ctx.objectives` is resolved through ctx.get at render time: the command composes
// without the objective group, at the cost of the dangling-link marker.

const USAGE
  = 'Usage: /decide [<question>|show <id>|choose <id> <option>|rev <id> <outcome>|super <id>|delete <id>]'

const ID_ACTIONS = ['show', 'choose', 'rev', 'super', 'delete'] as const

type DecisionCommand =
  | { readonly kind: 'overview' }
  | { readonly kind: 'create'; readonly question: string }
  | { readonly kind: 'show'; readonly prefix: string }
  | { readonly kind: 'choose'; readonly prefix: string; readonly label: string }
  | { readonly kind: 'review'; readonly prefix: string; readonly outcome: string }
  | { readonly kind: 'supersede'; readonly prefix: string }
  | { readonly kind: 'delete'; readonly prefix: string }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never, label: string): never {
  throw new TypeError(`unknown ${label}: ${String(value)}`)
}
/* v8 ignore stop */

/* jscpd:ignore-start -- command-parser boilerplate shared with dsh-command-objective; extract on a third command package */
/** Split the first word from the rest, both trimmed. */
function splitFirst(input: string): { word: string; rest: string } | undefined {
  const match = /^(\S+)\s+(.+)$/u.exec(input)
  return match === null ? undefined : { word: match[1] as string, rest: (match[2] as string).trim() }
}

/** Parse only the grammar owned by `/decide`; a lone non-keyword input is a question. */
function parseDecisionCommand(rawInput: string): DecisionCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'overview' }
  const split = splitFirst(input)
  if (split === undefined) {
    const control = input.toLowerCase()
    if ((ID_ACTIONS as readonly string[]).includes(control)) {
      return { kind: 'invalid', reason: `/decide ${control} requires a decision id${control === 'choose' ? ' and an option' : control === 'rev' ? ' and an outcome' : ''}.` }
    }
    return { kind: 'create', question: input }
  }
  const { word, rest } = split
  const control = word.toLowerCase()
  if (control === 'show' || control === 'super' || control === 'delete') {
    return control === 'show'
      ? { kind: 'show', prefix: rest }
      : control === 'super'
        ? { kind: 'supersede', prefix: rest }
        : { kind: 'delete', prefix: rest }
  }
  if (control === 'choose' || control === 'rev') {
    const split2 = splitFirst(rest)
    if (split2 === undefined) {
      return {
        kind: 'invalid',
        reason: `/decide ${control} requires a decision id and ${control === 'choose' ? 'an option label' : 'a one-line outcome'}.`,
      }
    }
    return control === 'choose'
      ? { kind: 'choose', prefix: split2.word, label: split2.rest }
      : { kind: 'review', prefix: split2.word, outcome: split2.rest }
  }
  return { kind: 'create', question: input }
}

/* jscpd:ignore-end */

/** Short human-facing id reference: the stable id's trailing segment. */
function idHint(id: DecisionId): string {
  return String(id).slice(-8)
}

/** Resolve one id fragment: the unique matching decision, or its error text. */
function resolveFragment(
  decisions: readonly DecisionView[],
  prefix: string,
): { decision: DecisionView } | { error: string } {
  // The command grammar guarantees a non-empty fragment (splitFirst requires rest).
  const matches = decisions.filter(decision => String(decision.id).includes(prefix))
  if (matches.length === 0) return { error: `No decision id matches '${prefix}'. Run /decide to list ids.` }
  if (matches.length > 1) {
    return { error: `Id '${prefix}' matches several decisions: ${matches.map(item => idHint(item.id)).join(', ')}. Use more characters.` }
  }
  return { decision: matches[0] as DecisionView }
}

/** One overview row: flag, question, and the decision's compact state. */
function row(ctx: Context, decision: DecisionView): string {
  const flag = decision.status === 'open' ? 'O' : decision.status === 'decided' ? 'D' : 'S'
  const tail = decision.status === 'decided'
    ? `→ ${decision.chosen}`
    : decision.status === 'superseded'
      ? 'superseded'
      : `${decision.options.length} options`
  return `[${flag}] ${decision.question} — ${tail}${linkFlagged(ctx, decision)} · ${idHint(decision.id)}`
}

/** Whether the decision's objective link is dangling or its objective is not active. */
function linkFlagged(ctx: Context, decision: DecisionView): string {
  if (decision.objectiveId === undefined) return ''
  const objectives = ctx.get('objectives')
  if (objectives === undefined) return ''
  const objective = objectives.get(decision.objectiveId)
  if (objective === undefined || objective.status !== 'active') return ' (!)'
  return ''
}

/** Whether a decided decision is past its review due date with no review yet. */
function dueUnreviewed(decision: DecisionView, hasReview: boolean): boolean {
  return decision.status === 'decided' && decision.dueAt !== undefined
    && Date.parse(decision.dueAt) <= Date.now() && !hasReview
}

/** Render the overview: rows, the due-unreviewed reminder, and usage. */
function renderOverview(ctx: Context): CommandResult {
  const decisions = ctx.decisions.list()
  const due: string[] = []
  for (const decision of decisions) {
    if (dueUnreviewed(decision, ctx.decisions.reviewsOf(decision.id).length > 0)) {
      due.push(`- ${decision.question} · ${idHint(decision.id)} → /decide rev ${idHint(decision.id)} <outcome>`)
    }
  }
  return {
    kind: 'success',
    text: [
      ...(decisions.length === 0 ? ['No decisions yet.'] : decisions.map(decision => row(ctx, decision))),
      ...(due.length === 0 ? [] : ['', `Due for review (${due.length}):`, ...due]),
      USAGE,
    ].join('\n'),
  }
}

/** Render one full decision card; the counter-evidence section always renders. */
function renderCard(title: string, decision: DecisionView): CommandResult {
  const options = decision.options.length === 0
    ? ['(no options drafted yet)']
    : decision.options.map(option => [
      `- ${option.label}: ${option.evidence}`,
      ...option.cost === undefined ? [] : [`    cost: ${option.cost}`],
      ...option.risk === undefined ? [] : [`    risk: ${option.risk}`],
    ].join('\n'))
  const recommendation = decision.recommendation === undefined
    ? '(no recommendation drafted)'
    : `${decision.recommendation}${decision.confidence === undefined ? '' : ` (confidence ${decision.confidence})`}`
  const counter = decision.counterEvidence.trim().length === 0
    ? '(none recorded — the card says so explicitly, absence is not silent)'
    : decision.counterEvidence
  const decided = decision.status === 'decided'
    ? [`Chosen: ${decision.chosen}${decision.predictedConfidence === undefined ? '' : ` (frozen at ${decision.predictedConfidence})`}`,
      // decide() always stamps decidedAt alongside the decided status.
      `Decided at: ${decision.decidedAt as string}`]
    : []
  return {
    kind: 'success',
    text: [
      title,
      `Status: ${decision.status} · reversibility: ${decision.reversibility}`,
      `Question: ${decision.question}`,
      'Options:',
      ...options,
      `Recommendation: ${recommendation}`,
      ...decision.rationale === undefined ? [] : [`Rationale: ${decision.rationale}`],
      'Counter-evidence:',
      counter,
      ...decided,
      `Id: ${idHint(decision.id)}`,
    ].join('\n'),
  }
}

/** Execute one parsed human command through the registry that owns persistence. */
async function executeDecisionCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const command = parseDecisionCommand(invocation.rawInput)
  const registry = ctx.decisions
  try {
    switch (command.kind) {
      case 'overview':
        return renderOverview(ctx)
      case 'invalid':
        return { kind: 'error', text: `${command.reason}\n${USAGE}` }
      case 'create': {
        const decision = await registry.create({ question: command.question })
        return renderCard('Decision created', decision)
      }
      case 'show': {
        const found = resolveFragment(registry.list(), command.prefix)
        if ('error' in found) return { kind: 'error', text: found.error }
        return renderCard('Decision', found.decision)
      }
      case 'choose': {
        const found = resolveFragment(registry.list(), command.prefix)
        if ('error' in found) return { kind: 'error', text: found.error }
        // Trailing 'confirm <stamp>' carries the irreversible second pass.
        let label = command.label
        let confirm = false
        let expectedUpdatedAt: string | undefined
        const confirmMatch = /\s+confirm(?:\s+(\S+))?$/u.exec(label)
        if (confirmMatch !== null) {
          confirm = true
          expectedUpdatedAt = confirmMatch[1]
          label = label.slice(0, confirmMatch.index).trim()
        }
        try {
          const decided = await registry.decide(found.decision.id, label, {
            confirm,
            ...expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt },
          })
          return renderCard('Decision made', decided)
        } catch (error) {
          if (error instanceof DecisionError && error.code === 'DECISION_IRREVERSIBLE_CONFIRM') {
            // The overview row is a stale snapshot; the confirmation block
            // quotes the card as it stands right now.
            /* v8 ignore next -- the fallback survives only a delete racing this call */
            const card = registry.get(found.decision.id) ?? found.decision
            return {
              kind: 'error',
              text: [
                'This decision is IRREVERSIBLE. Read the card before confirming:',
                `Counter-evidence: ${card.counterEvidence.trim().length === 0 ? '(none recorded)' : card.counterEvidence}`,
                ...card.options.map(option => `  ${option.label}: ${option.evidence}`),
                '',
                `Stamp: ${card.updatedAt}`,
                `Confirm with: /decide choose ${idHint(card.id)} ${label} confirm ${card.updatedAt}`,
                'If the stamp differs when you re-read the card, the card changed under you — re-read it.',
              ].join('\n'),
            }
          }
          if (error instanceof DecisionError && error.code === 'DECISION_STALE_CARD') {
            return { kind: 'error', text: `The card changed since the stamp you confirmed against. Re-read it with /decide show ${idHint(found.decision.id)} and choose again.` }
          }
          throw error
        }
      }
      case 'review': {
        const found = resolveFragment(registry.list(), command.prefix)
        if ('error' in found) return { kind: 'error', text: found.error }
        const review = await registry.recordReview(found.decision.id, command.outcome)
        const prediction = review.predictedConfidence === undefined
          ? 'no frozen prediction'
          : `predicted ${review.predictedConfidence}`
        return {
          kind: 'success',
          text: [
            'Review recorded.',
            `Prediction: ${prediction}`,
            `Outcome: ${review.actualOutcome}`,
            'Calibration trail keeps this row even after the decision is deleted.',
          ].join('\n'),
        }
      }
      case 'supersede': {
        const found = resolveFragment(registry.list(), command.prefix)
        if ('error' in found) return { kind: 'error', text: found.error }
        const superseded = await registry.supersede(found.decision.id)
        return renderCard('Decision superseded', superseded)
      }
      case 'delete': {
        const found = resolveFragment(registry.list(), command.prefix)
        if ('error' in found) return { kind: 'error', text: found.error }
        await registry.delete(found.decision.id)
        return { kind: 'success', text: `Decision deleted: ${found.decision.question} (review trail kept)` }
      }
      /* v8 ignore next 2 -- DecisionCommand is closed and every member is handled above */
      default: return assertNever(command, 'decision command')
    }
  } catch (error: unknown) {
    if (error instanceof DecisionError) {
      return {
        kind: 'error',
        text: 'The decide command is not valid for the current state. Run /decide to list decisions and ids.',
      }
    }
    throw error
  }
}

/** Register the Codex-shaped `/decide` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'decide',
    description: 'list or manage cross-session decisions',
    input: { hint: '[<question>|show <id>|choose <id> <option>|rev <id> <outcome>|super <id>|delete <id>]' },
    handler: invocation => executeDecisionCommand(ctx, invocation),
  })
}
