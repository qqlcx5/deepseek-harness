/** Execution-time authority checks for the model-facing objective tools. */

/* jscpd:ignore-start -- mirrors dsh-tool-goal's authority over a different domain; extraction waits for a third consumer */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

type TurnStartEvent = Extract<SessionEvent, { type: 'turn/start' }>

/** Current open turn plus the events accepted after its start boundary. */
export interface ObjectiveToolExecution {
  readonly agent: Agent
  readonly start: TurnStartEvent
  readonly events: readonly SessionEvent[]
}

/** Throw one structured tool-policy failure. */
function reject(message: string, code = 'OBJECTIVE_TOOL_AUTHORITY_REQUIRED'): never {
  throw new HarnessError(message, code)
}

/** Locate the open turn enclosing a model tool call. */
function openTurn(agent: Agent): { start: TurnStartEvent; events: readonly SessionEvent[] } {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const boundary = events[index]
    if (boundary?.type === 'turn/end') {
      reject('objective tools require an open model turn', 'OBJECTIVE_TOOL_DRIVER_REQUIRED')
    }
    if (boundary?.type === 'turn/start') {
      return { start: boundary, events: events.slice(index + 1) }
    }
  }
  return reject('objective tools require an open model turn', 'OBJECTIVE_TOOL_DRIVER_REQUIRED')
}

/**
 * Resolve and authenticate the calling agent and its driver boundary.
 * @param ctx - Context carrying the live agent registry.
 * @param exec - Tool execution metadata supplied by the registry.
 * @returns The authenticated agent and its current turn window.
 */
export function objectiveToolExecution(ctx: Context, exec: ToolRunContext): ObjectiveToolExecution {
  const agent = exec.agent
  if (agent === undefined) {
    return reject('objective tools require a calling agent', 'OBJECTIVE_TOOL_AGENT_REQUIRED')
  }
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    return reject(
      'objective tools require the exact live calling agent inside its active driver',
      'OBJECTIVE_TOOL_DRIVER_REQUIRED',
    )
  }
  return { agent, ...openTurn(agent) }
}

/**
 * Whether host-attested human input appears in the current root-agent turn.
 * An omitted `Agent.followup()` / `steer()` source resolves to `user`, so non-human
 * producers must supply their own source rather than inheriting this authority.
 */
function hasDirectHumanInput(ctx: Context, execution: ObjectiveToolExecution): boolean {
  if (!ctx.agents.roots().includes(execution.agent)) return false
  return execution.events.some(event =>
    event.type === 'user/message' && event.data.source.kind === 'user')
}

/**
 * Require authority originating in a human message accepted by a runtime root.
 * @param ctx - Context carrying the live agent graph.
 * @param execution - Authenticated current tool execution.
 */
export function requireDirectHuman(ctx: Context, execution: ObjectiveToolExecution): void {
  if (hasDirectHumanInput(ctx, execution)) return
  reject('this objective operation requires a direct human turn on a top-level agent')
}
/* jscpd:ignore-end */
