/**
 * Model-facing `list_objectives`, `get_objective`, `create_objective`, and
 * `attach_objective` tools over the cross-session objective registry.
 * @module @deepseek-ai/dsh-tool-objective
 */

import type { Context } from '@deepseek-ai/cordis'
import { ObjectiveId } from '@deepseek-ai/dsh-objective'
import type { ObjectiveView } from '@deepseek-ai/dsh-objective'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { objectiveToolExecution, requireDirectHuman } from './authority.ts'

export const name = 'tool-objective'
export const inject = ['agents', 'objectives', 'tools', 'systemPrompt']

const LIST_DESCRIPTION
  = 'List every cross-session objective in registry order with its status, member-session '
    + 'count, and whether a synthesis brief and a north-star statement exist. Read this before '
    + 'creating an objective, to avoid duplicates and to find an existing objective to attach the '
    + 'current session to.'

const GET_DESCRIPTION
  = 'Read one objective in full: title, north-star statement, status, cached synthesis brief '
    + 'with its timestamp, and the ordered member sessions. Use the brief as the current '
    + 'cross-session conclusion instead of re-reading every member session.'

const CREATE_DESCRIPTION
  = 'Create one cross-session objective when the direct human request names a durable intent '
    + 'that will span sessions — a goal bigger than this conversation. Do not use this for '
    + 'single-session work (the same-session goal tools own that). Requires a direct human turn.'

const ATTACH_DESCRIPTION
  = 'Attach the current session to one existing objective, recording that this session serves '
    + 'that intent. Prefer proposing this right after a human confirms the session belongs to an '
    + 'objective. Requires a direct human turn.'

const OBJECTIVE_GUIDANCE
  = 'Objective tools manage cross-session intent containers: durable goals that span sessions. '
    + 'list_objectives first to avoid duplicates. create_objective only when the human names a '
    + 'durable cross-session intent — single-session completion belongs to goal tools. '
    + 'attach_objective records that the current session serves an objective; a session may '
    + 'serve several. Creation and attachment require a direct human turn on a top-level agent.'

/** One objective row in the compact list output. */
interface ObjectiveSummaryValue {
  readonly id: string
  readonly title: string
  readonly status: ObjectiveView['status']
  readonly memberCount: number
  readonly hasNorthStar: boolean
  readonly hasBrief: boolean
}

/** Full objective value shared by get, create, and attach outputs. */
interface ObjectiveDetailValue {
  readonly id: string
  readonly title: string
  readonly status: ObjectiveView['status']
  readonly sessionIds: string[]
  readonly northStar?: string
  readonly brief?: string
  readonly briefAt?: string
}

const STATUS_ENUM = ['active', 'parked', 'closed'] as const

const OBJECTIVE_DETAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: STATUS_ENUM },
    sessionIds: { type: 'array', required: true, items: { type: 'string' } },
    northStar: { type: 'string' },
    brief: { type: 'string' },
    briefAt: { type: 'string' },
  },
} as const

const LIST_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objectives: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: STATUS_ENUM },
          memberCount: { type: 'integer', required: true },
          hasNorthStar: { type: 'boolean', required: true },
          hasBrief: { type: 'boolean', required: true },
        },
      },
    },
  },
} as const

const GET_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objective: { required: true, oneOf: [{ type: 'null' }, OBJECTIVE_DETAIL_SCHEMA] },
  },
} as const

const CREATE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objective: { required: true, ...OBJECTIVE_DETAIL_SCHEMA },
  },
} as const

/** Compact list row for one objective. */
function summaryValue(objective: ObjectiveView): ObjectiveSummaryValue {
  return {
    id: objective.id,
    title: objective.title,
    status: objective.status,
    memberCount: objective.sessionIds.length,
    hasNorthStar: objective.northStar !== undefined,
    hasBrief: objective.brief !== undefined,
  }
}

/** Full detail value for one objective. */
function detailValue(objective: ObjectiveView): ObjectiveDetailValue {
  return {
    id: objective.id,
    title: objective.title,
    status: objective.status,
    sessionIds: [...objective.sessionIds],
    ...objective.northStar === undefined ? {} : { northStar: objective.northStar },
    ...objective.brief === undefined ? {} : { brief: objective.brief },
    ...objective.briefAt === undefined ? {} : { briefAt: objective.briefAt },
  }
}

/** Reusable canonical output declaration for the detail-returning tools. */
/* jscpd:ignore-start -- canonical tool-output boilerplate shared with dsh-tool-goal; extraction awaits a third consumer */
const DETAIL_OUTPUT = {
  schema: CREATE_OUTPUT_SCHEMA,
  render: (_args: unknown, value: { objective: ObjectiveDetailValue }) =>
    [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Generic, args-only pending presentation shared by the objective tools. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}
/* jscpd:ignore-end */

/** Register the four objective tools and their shared policy section. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'tool:objective', order: 117, text: OBJECTIVE_GUIDANCE })

  ctx.tools.register(defineTool({
    name: 'list_objectives',
    description: LIST_DESCRIPTION,
    parameters: {},
    output: {
      schema: LIST_OUTPUT_SCHEMA,
      render: (_args: unknown, value: { objectives: ObjectiveSummaryValue[] }) =>
        [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute(_args, exec) {
      objectiveToolExecution(ctx, exec)
      return Promise.resolve({ objectives: ctx.objectives.list().map(summaryValue) })
    },
    presentCall: () => present('List objectives', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'get_objective',
    description: GET_DESCRIPTION,
    parameters: {
      objective_id: { type: 'string', required: true, description: 'Exact objective id from list_objectives.' },
    },
    output: {
      schema: GET_OUTPUT_SCHEMA,
      render: (_args: unknown, value: { objective: ObjectiveDetailValue | null }) =>
        [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      objectiveToolExecution(ctx, exec)
      const objective = ctx.objectives.get(ObjectiveId(args.objective_id))
      return Promise.resolve({ objective: objective === undefined ? null : detailValue(objective) })
    },
    presentCall: args => present('Read objective', 'read', args.objective_id),
  }))

  ctx.tools.register(defineTool({
    name: 'create_objective',
    description: CREATE_DESCRIPTION,
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'Short display title for the durable intent.',
      },
      north_star: {
        type: 'string',
        description: 'Optional one-sentence statement of what done looks like.',
      },
    },
    output: DETAIL_OUTPUT,
    async execute(args, exec) {
      const execution = objectiveToolExecution(ctx, exec)
      requireDirectHuman(ctx, execution)
      const objective = await ctx.objectives.create({
        title: args.title,
        ...args.north_star === undefined ? {} : { northStar: args.north_star },
      })
      return { objective: detailValue(objective) }
    },
    presentCall: args => present('Create objective', 'other', args.title),
  }))

  ctx.tools.register(defineTool({
    name: 'attach_objective',
    description: ATTACH_DESCRIPTION,
    parameters: {
      objective_id: {
        type: 'string',
        required: true,
        description: 'Exact objective id from list_objectives.',
      },
    },
    output: DETAIL_OUTPUT,
    async execute(args, exec) {
      const execution = objectiveToolExecution(ctx, exec)
      requireDirectHuman(ctx, execution)
      const objective = await ctx.objectives.attachSession(
        ObjectiveId(args.objective_id),
        execution.agent.session.id,
      )
      return { objective: detailValue(objective) }
    },
    presentCall: args => present('Attach to objective', 'other', args.objective_id),
  }))
}
