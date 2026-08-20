/**
 * Objective synthesis consumer: one fan-in meta-agent over the subagent seam.
 * It collects each member session's recent conclusions through the
 * session-query seam, delegates one one-shot structured child, and writes the
 * cached brief back through `ctx.objectives.setBrief`. Delegation is fan-in
 * only: the child is started with `maxDepth: 0` so it cannot delegate further.
 * @module @deepseek-ai/dsh-objective-synthesizer
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { ObjectiveError, ObjectiveId } from '@deepseek-ai/dsh-objective'
import type { ObjectiveView } from '@deepseek-ai/dsh-objective'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

export const name = 'objective-synthesizer'
export const inject = ['commands', 'objectives', 'sessionQuery', 'subagents']

/** Deployment-owned delegation target and material limits. */
export interface Config {
  /** Registered `ctx.subagents` provider name that runs the synthesis child. */
  provider?: string
  /** Trailing assistant messages each member session contributes. */
  materialTail?: number
  /** Per-message character cap for contributed material. */
  messageCapChars?: number
}

/** Schemastery config for the synthesis delegation target and material limits. */
export const Config: z<Config> = z.object({
  provider: z.string().default('spawn'),
  materialTail: z.number().step(1).min(1).default(3),
  messageCapChars: z.number().step(1).min(200).default(2000),
})

/** Fully materialized synthesis policy. */
export interface ResolvedConfig {
  readonly provider: string
  readonly materialTail: number
  readonly messageCapChars: number
}

/** Validate config even when apply is called directly outside Loader normalization.
 * @param config - Raw plugin config.
 * @returns the fully materialized synthesis policy.
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

/** Stable error codes for rejected synthesis runs. */
export type ObjectiveSynthesisErrorCode =
  | 'SYNTH_NO_MEMBERS'
  | 'SYNTH_OBJECTIVE_NOT_ACTIVE'
  | 'SYNTH_CHILD_FAILED'
  | 'SYNTH_NO_STRUCTURED_OUTPUT'

/** A rejected synthesis run, carrying its stable code. */
export class ObjectiveSynthesisError extends HarnessError {
  /**
   * @param message - Human-readable rejection reason.
   * @param code - Stable error code for routing.
   */
  constructor(message: string, code: ObjectiveSynthesisErrorCode) {
    super(message, code)
    this.name = 'ObjectiveSynthesisError'
  }
}

/** Structured child output: the brief paragraph plus its open questions. */
export interface SynthesisOutput {
  readonly brief: string
  readonly openQuestions: readonly string[]
}

/** Object-rooted JSON Schema of the child's structured result. */
const SYNTHESIS_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['brief', 'openQuestions'],
  properties: {
    brief: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

/** The stable instruction prefix every synthesis child receives. */
const SYNTHESIS_INSTRUCTION
  = 'You are the synthesis step for one cross-session objective. From the member-session material '
    + 'below, write exactly one paragraph stating what the sessions collectively concluded so far, '
    + 'then at most three open questions a decision still waits on. Use only the material; do not '
    + 'invent progress. Return the structured result and nothing else.'

/** Extract the text of one assistant message's content blocks. */
function assistantText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** Render one member session's contribution: its trailing conclusions. */
function renderMember(
  sessionId: SessionId,
  snapshot: SessionLogSnapshot,
  materialTail: number,
  messageCapChars: number,
): string {
  const conclusions: string[] = []
  for (const event of snapshot.events) {
    if (event.type !== 'assistant/message') continue
    const text = assistantText(event.data.message.content)
    if (text.length > 0) conclusions.push(text)
  }
  const tail = conclusions.slice(-materialTail)
    .map(text => text.length > messageCapChars ? `${text.slice(0, messageCapChars)}…` : text)
  return [
    `Session ${String(sessionId).slice(-8)}:`,
    ...(tail.length === 0 ? ['(no recorded assistant conclusions)'] : tail.map(text => `- ${text}`)),
  ].join('\n')
}

/** Assemble the full child prompt block for one objective's material. */
function synthesisPrompt(objective: ObjectiveView, material: readonly string[]): ContentBlock {
  return {
    type: 'text',
    text: [
      SYNTHESIS_INSTRUCTION,
      '',
      `Objective: ${objective.title}`,
      ...objective.northStar === undefined ? [] : [`North star: ${objective.northStar}`],
      '',
      'Member-session material:',
      ...material,
    ].join('\n'),
  }
}

/** Validate the child's structured result into one SynthesisOutput. */
function validateOutput(structured: unknown): SynthesisOutput {
  if (typeof structured !== 'object' || structured === null) {
    throw new ObjectiveSynthesisError('the synthesis child returned no structured result', 'SYNTH_NO_STRUCTURED_OUTPUT')
  }
  const brief = (structured as { brief?: unknown }).brief
  const questions = (structured as { openQuestions?: unknown }).openQuestions
  if (typeof brief !== 'string' || brief.trim().length === 0 || !Array.isArray(questions)
    || questions.some(question => typeof question !== 'string')) {
    throw new ObjectiveSynthesisError('the synthesis child returned a malformed structured result', 'SYNTH_NO_STRUCTURED_OUTPUT')
  }
  return { brief: brief.trim(), openQuestions: questions.filter(question => (question as string).trim().length > 0) }
}

/** Render the stored brief: the paragraph plus its open-question list. */
function renderBriefText(output: SynthesisOutput): string {
  return output.openQuestions.length === 0
    ? output.brief
    : [
      output.brief,
      '',
      'Open questions:',
      ...output.openQuestions.map(question => `- ${question}`),
    ].join('\n')
}

/**
 * Read each member session's trailing conclusions through the session-query
 * seam (live-preferred; a session that fails replay rejects the whole run).
 * @param ctx - Context carrying `ctx.sessionQuery`.
 * @param objective - The objective whose members are read.
 * @param limits - Material limits: the trailing-message count and per-message cap.
 * @returns one material block per member, in the objective's member order.
 */
export async function collectMemberMaterial(
  ctx: Context,
  objective: ObjectiveView,
  limits: Pick<ResolvedConfig, 'materialTail' | 'messageCapChars'>,
): Promise<string[]> {
  const material: string[] = []
  for (const sessionId of objective.sessionIds) {
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    material.push(renderMember(sessionId, snapshot, limits.materialTail, limits.messageCapChars))
  }
  return material
}

/**
 * Run one synthesis delegation for an objective and store its brief.
 * @param ctx - Context carrying `ctx.objectives`, `ctx.sessionQuery`, and `ctx.subagents`.
 * @param resolved - The materialized synthesis policy (provider and material limits).
 * @param parent - Live agent whose context anchors the delegation.
 * @param objectiveId - The objective to synthesize.
 * @param signal - Cancellation channel for the child run.
 * @returns the updated objective view carrying the fresh brief.
 * @throws {@link ObjectiveError} when the objective is unknown.
 * @throws {@link ObjectiveSynthesisError} when there is no material, the child fails, or the structured result is missing.
 */
export async function synthesizeObjective(
  ctx: Context,
  resolved: ResolvedConfig,
  parent: Agent,
  objectiveId: ObjectiveId,
  signal: AbortSignal,
): Promise<ObjectiveView> {
  const objective = ctx.objectives.get(objectiveId)
  if (objective === undefined) {
    throw new ObjectiveError(`no objective '${String(objectiveId)}'`, 'OBJECTIVE_NOT_FOUND')
  }
  // A parked objective is the WIP lever and is skipped; a closed one must be
  // reopened first.
  if (objective.status !== 'active') {
    throw new ObjectiveSynthesisError(
      `objective '${objective.title}' is ${objective.status}; the synthesizer skips non-active objectives`,
      'SYNTH_OBJECTIVE_NOT_ACTIVE',
    )
  }
  const material = await collectMemberMaterial(ctx, objective, resolved)
  if (objective.sessionIds.length === 0) {
    throw new ObjectiveSynthesisError(
      `objective '${objective.title}' has no member sessions to synthesize`,
      'SYNTH_NO_MEMBERS',
    )
  }
  const run = await ctx.subagents.start(resolved.provider, {
    prompt: [synthesisPrompt(objective, material)],
    parent,
    signal,
    outputSchema: SYNTHESIS_OUTPUT_SCHEMA,
    maxDepth: 0,
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') {
      throw new ObjectiveSynthesisError(
        `the synthesis child ended with stop reason "${result.stopReason}"`,
        'SYNTH_CHILD_FAILED',
      )
    }
    const briefText = renderBriefText(validateOutput(result.structured))
    // Compare-and-set on the brief stamp the run read: a concurrent synthesis
    // that stored a brief in between rejects instead of silently overwriting.
    return await ctx.objectives.setBrief(objectiveId, briefText, objective.briefAt ?? null)
  } finally {
    await run.dispose()
  }
}

/** Resolve one id fragment: the unique matching objective, or its error text. */
function resolveObjectiveFragment(ctx: Context, fragment: string): { id: ObjectiveId } | { error: string } {
  const trimmed = fragment.trim()
  if (trimmed.length === 0) return { error: 'Usage: /synthesize <objective id>' }
  const matches = ctx.objectives.list().filter(objective => String(objective.id).includes(trimmed))
  if (matches.length === 0) return { error: `No objective id matches '${trimmed}'. Run /objective to list ids.` }
  if (matches.length > 1) {
    return { error: `Id '${trimmed}' matches several objectives; use more characters.` }
  }
  return { id: (matches[0] as ObjectiveView).id }
}

/** Register the `/synthesize` command over the same delegation path. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.commands.register({
    name: 'synthesize',
    description: 'run one synthesis pass over an objective and store its brief',
    input: { hint: '<objective id>' },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const resolvedFragment = resolveObjectiveFragment(ctx, invocation.rawInput)
      if ('error' in resolvedFragment) return { kind: 'error', text: resolvedFragment.error }
      try {
        const objective = await synthesizeObjective(ctx, resolved, invocation.agent, resolvedFragment.id, invocation.signal)
        return {
          kind: 'success',
          text: [
            `Brief stored for ${objective.title} (${objective.briefAt}):`,
            objective.brief,
          ].join('\n'),
        }
      } catch (error: unknown) {
        if (error instanceof ObjectiveError || error instanceof ObjectiveSynthesisError) {
          return { kind: 'error', text: `Synthesis failed: ${error.message}` }
        }
        throw error
      }
    },
  })
}
