/**
 * Decision drafter: one fan-in meta-agent over the subagent seam. It gathers
 * the decision question plus its objective's brief and member conclusions,
 * delegates one one-shot structured child, and writes the draft card through
 * `ctx.decisions.update` — options, recommendation, confidence, the mandatory
 * counter-evidence section, and a reversibility suggestion. It never writes
 * `decided`: choosing stays a human interaction. The child runs with
 * `maxDepth: 0`, so the pass cannot fan out further.
 * @module @deepseek-ai/dsh-decision-drafter
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { DecisionError, DecisionId } from '@deepseek-ai/dsh-decision'
import type { DecisionOption, DecisionView, Reversibility } from '@deepseek-ai/dsh-decision'
import { ObjectiveId } from '@deepseek-ai/dsh-objective'
import { collectMemberMaterial } from '@deepseek-ai/dsh-objective-synthesizer'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'decision-drafter'
export const inject = ['commands', 'decisions', 'objectives', 'sessionQuery', 'subagents']

/* jscpd:ignore-start -- delegation config trio shared with dsh-objective-synthesizer; extract on a third delegating consumer */
/** Delegation target and material limits for the drafting pass. */
export interface Config {
  /** Registered `ctx.subagents` provider name that runs the drafting child. */
  provider?: string
  /** Trailing assistant messages each member session contributes. */
  materialTail?: number
  /** Per-message character cap for contributed material. */
  messageCapChars?: number
}

/** Schemastery config for the drafting delegation target and material limits. */
export const Config: z<Config> = z.object({
  provider: z.string().default('spawn'),
  materialTail: z.number().step(1).min(1).default(3),
  messageCapChars: z.number().step(1).min(200).default(2000),
})

/** Fully materialized drafting policy. */
export interface ResolvedConfig {
  readonly provider: string
  readonly materialTail: number
  readonly messageCapChars: number
}

/* jscpd:ignore-end */

/** Stable error codes for rejected drafting runs. */
export type DecisionDrafterErrorCode =
  | 'DRAFT_CHILD_FAILED'
  | 'DRAFT_NO_STRUCTURED_OUTPUT'

/** A rejected drafting run, carrying its stable code. */
export class DecisionDrafterError extends HarnessError {
  /**
   * @param message - Human-readable rejection reason.
   * @param code - Stable error code for routing.
   */
  constructor(message: string, code: DecisionDrafterErrorCode) {
    super(message, code)
    this.name = 'DecisionDrafterError'
  }
}

/** Structured child output: the draft card. */
export interface DraftOutput {
  readonly options: readonly {
    readonly label: string
    readonly evidence: string
    readonly cost?: string
    readonly risk?: string
  }[]
  readonly recommendation: string
  readonly rationale: string
  readonly confidence: number
  readonly counterEvidence: string
  readonly reversibility: Reversibility
}

/** Object-rooted JSON Schema of the child's structured result. */
const DRAFT_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['options', 'recommendation', 'rationale', 'confidence', 'counterEvidence', 'reversibility'],
  properties: {
    options: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'evidence'],
        properties: {
          label: { type: 'string' },
          evidence: { type: 'string' },
          cost: { type: 'string' },
          risk: { type: 'string' },
        },
      },
    },
    recommendation: { type: 'string' },
    rationale: { type: 'string' },
    confidence: { type: 'number' },
    counterEvidence: { type: 'string' },
    reversibility: { type: 'string', enum: ['reversible', 'costly', 'irreversible'] },
  },
}

/** The stable instruction prefix every drafting child receives. */
const DRAFT_INSTRUCTION
  = 'You are the drafting step for one strategic decision. From the question and the material '
    + 'below, draft the decision card: the realistic options with their evidence, cost, and risk; '
    + 'one recommendation with its rationale and your confidence in [0, 1]; a reversibility '
    + 'suggestion; and the counter-evidence section — what the material says AGAINST the '
    + 'recommendation or against deciding now. The counter-evidence may be an empty string only '
    + 'when nothing in the material argues against; never invent, never omit what is there. Use '
    + 'only the material. Return the structured result and nothing else.'

/** Validate the child's structured result into one DraftOutput. */
function validateOutput(structured: unknown): DraftOutput {
  if (typeof structured !== 'object' || structured === null) {
    throw new DecisionDrafterError('the drafting child returned no structured result', 'DRAFT_NO_STRUCTURED_OUTPUT')
  }
  const record = structured as {
    options?: unknown
    recommendation?: unknown
    rationale?: unknown
    confidence?: unknown
    counterEvidence?: unknown
    reversibility?: unknown
  }
  const optionsValid = Array.isArray(record.options)
    && record.options.every((option): boolean => {
      if (typeof option !== 'object' || option === null) return false
      const candidate = option as { label?: unknown; evidence?: unknown }
      return typeof candidate.label === 'string' && candidate.label.trim().length > 0
        && typeof candidate.evidence === 'string'
    })
  if (!optionsValid || typeof record.recommendation !== 'string' || typeof record.rationale !== 'string'
    || typeof record.confidence !== 'number' || !(record.confidence >= 0 && record.confidence <= 1)
    || typeof record.counterEvidence !== 'string'
    || (record.reversibility !== 'reversible' && record.reversibility !== 'costly' && record.reversibility !== 'irreversible')) {
    throw new DecisionDrafterError('the drafting child returned a malformed structured result', 'DRAFT_NO_STRUCTURED_OUTPUT')
  }
  const options: DecisionOption[] = (record.options as { label: string; evidence: string; cost?: string; risk?: string }[])
    .map(option => ({
      label: option.label.trim(),
      evidence: option.evidence,
      ...option.cost === undefined ? {} : { cost: option.cost },
      ...option.risk === undefined ? {} : { risk: option.risk },
    }))
  return {
    options,
    recommendation: record.recommendation,
    rationale: record.rationale,
    confidence: record.confidence,
    counterEvidence: record.counterEvidence,
    reversibility: record.reversibility,
  }
}

/** Resolve one id fragment against a list: unique match or its error text. */
function resolveFragment(
  ids: readonly { id: DecisionId | ObjectiveId }[],
  prefix: string,
  kind: string,
): { id: string } | { error: string } {
  const matches = ids.filter(entry => String(entry.id).includes(prefix))
  if (matches.length === 0) return { error: `No ${kind} id matches '${prefix}'.` }
  if (matches.length > 1) {
    return { error: `Id '${prefix}' matches several ${kind}s; use more characters.` }
  }
  return { id: String((matches[0] as { id: DecisionId | ObjectiveId }).id) }
}

/** Assemble the full child prompt block. */
function draftPrompt(
  question: string,
  objectiveTitle: string | undefined,
  brief: string | undefined,
  material: readonly string[],
): ContentBlock {
  return {
    type: 'text',
    text: [
      DRAFT_INSTRUCTION,
      '',
      `Question: ${question}`,
      ...objectiveTitle === undefined ? [] : [`Objective: ${objectiveTitle}`],
      ...brief === undefined ? [] : ['Objective brief:', brief],
      '',
      'Material:',
      ...(material.length === 0 ? ['(no member-session material available)'] : material),
    ].join('\n'),
  }
}

/**
 * Run one drafting delegation for an open decision and store the draft card.
 * @param ctx - Context carrying the composed services.
 * @param resolved - The materialized drafting policy.
 * @param parent - Live agent whose context anchors the delegation.
 * @param decisionId - The open decision to draft.
 * @param objectiveId - Optional explicit objective; defaults to the decision's own.
 * @param signal - Cancellation channel for the child run.
 * @returns the updated decision view carrying the draft card.
 * @throws {@link DecisionError} when the decision is unknown or not open.
 * @throws {@link DecisionDrafterError} when the child fails or the structured result is missing or malformed.
 */
export async function draftDecision(
  ctx: Context,
  resolved: ResolvedConfig,
  parent: Agent,
  decisionId: DecisionId,
  objectiveId: ObjectiveId | undefined,
  signal: AbortSignal,
): Promise<DecisionView> {
  const decision = ctx.decisions.get(decisionId)
  if (decision === undefined) {
    throw new DecisionError(`no decision '${String(decisionId)}'`, 'DECISION_NOT_FOUND')
  }
  if (decision.status !== 'open') {
    throw new DecisionError(
      `decision '${decision.question}' is ${decision.status}; only an open decision accepts a draft`,
      'DECISION_INVALID_TRANSITION',
    )
  }
  const target = objectiveId ?? decision.objectiveId
  let objectiveTitle: string | undefined
  let brief: string | undefined
  let material: string[] = []
  if (target !== undefined) {
    const objective = ctx.objectives.get(target)
    if (objective !== undefined) {
      objectiveTitle = objective.title
      brief = objective.brief
      if (objective.sessionIds.length > 0) {
        material = await collectMemberMaterial(ctx, objective, resolved)
      }
    }
  }
  const run = await ctx.subagents.start(resolved.provider, {
    prompt: [draftPrompt(decision.question, objectiveTitle, brief, material)],
    parent,
    signal,
    outputSchema: DRAFT_OUTPUT_SCHEMA,
    maxDepth: 0,
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') {
      throw new DecisionDrafterError(
        `the drafting child ended with stop reason "${result.stopReason}"`,
        'DRAFT_CHILD_FAILED',
      )
    }
    const output = validateOutput(result.structured)
    return await ctx.decisions.update(decisionId, {
      options: output.options,
      recommendation: output.recommendation,
      rationale: output.rationale,
      confidence: output.confidence,
      counterEvidence: output.counterEvidence,
      reversibility: output.reversibility,
    })
  } finally {
    await run.dispose()
  }
}

/** Parse the command grammar: decision fragment plus optional objective fragment. */
function parseDraftCommand(rawInput: string): { decision: string; objective: string } | { error: string } {
  const input = rawInput.trim()
  if (input.length === 0) return { error: 'Usage: /decide-draft <decision id> [objective id]' }
  // The regex always matches a non-empty input, so no null arm exists.
  const split = /^\S+\s*/u.exec(input) as RegExpExecArray
  return { decision: split[0].trim(), objective: input.slice(split[0].length).trim() }
}

/* jscpd:ignore-start -- config validation shared with dsh-objective-synthesizer */
/** Validate config even when apply is called directly outside Loader normalization.
 * @param config - Raw plugin config.
 * @returns the fully materialized drafting policy.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const provider = config.provider ?? 'spawn'
  const materialTail = config.materialTail ?? 3
  const messageCapChars = config.messageCapChars ?? 2000
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new TypeError('provider must be a non-empty string')
  }
  if (!Number.isSafeInteger(materialTail) || materialTail < 1) {
    throw new TypeError('materialTail must be a positive safe integer')
  }
  if (!Number.isSafeInteger(messageCapChars) || messageCapChars < 200) {
    throw new TypeError('messageCapChars must be a safe integer of at least 200')
  }
  return { provider, materialTail, messageCapChars }
}

/* jscpd:ignore-end */

/** Register the `/decide-draft` command over the same delegation path. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.commands.register({
    name: 'decide-draft',
    description: 'draft a decision card for an open decision through one delegation',
    input: { hint: '<decision id> [objective id]' },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const parsed = parseDraftCommand(invocation.rawInput)
      if ('error' in parsed) return { kind: 'error', text: parsed.error }
      const decisionId = resolveFragment(ctx.decisions.list(), parsed.decision, 'decision')
      if ('error' in decisionId) return { kind: 'error', text: decisionId.error }
      let objectiveId: ObjectiveId | undefined
      if (parsed.objective.length > 0) {
        const resolvedObjective = resolveFragment(ctx.objectives.list(), parsed.objective, 'objective')
        if ('error' in resolvedObjective) return { kind: 'error', text: resolvedObjective.error }
        objectiveId = ObjectiveId(resolvedObjective.id)
      }
      try {
        const decision = await draftDecision(ctx, resolved, invocation.agent, DecisionId(decisionId.id), objectiveId, invocation.signal)
        return {
          kind: 'success',
          text: [
            `Card drafted for: ${decision.question}`,
            `${decision.options.length} options, recommendation '${decision.recommendation}' (confidence ${decision.confidence}).`,
            `Counter-evidence section: ${decision.counterEvidence.trim().length === 0 ? '(empty)' : 'recorded'}`,
            `Review with /decide show ${String(decision.id).slice(-8)}, then /decide choose ${String(decision.id).slice(-8)} <option>.`,
          ].join('\n'),
        }
      } catch (error: unknown) {
        if (error instanceof DecisionError || error instanceof DecisionDrafterError) {
          return { kind: 'error', text: `Drafting failed: ${error.message}` }
        }
        throw error
      }
    },
  })
}
