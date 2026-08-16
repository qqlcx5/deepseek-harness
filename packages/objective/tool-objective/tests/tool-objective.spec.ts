import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import ObjectiveRegistry from '@deepseek-ai/dsh-objective'
import { createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolObjective from '@deepseek-ai/dsh-tool-objective'

const testToolSignal = new AbortController().signal

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  setStatus(status: AgentStatus): void
}

/** Build one registry-compatible live agent whose injections enter the durable inbox. */
function stubAgent(supplied: Session): StubAgent {
  const session = supplied
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status() { return status },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, setStatus(value) { status = value } }
}

/** Open one message-triggered turn with its accepted model-visible input. */
function openTurn(stub: StubAgent, source: { kind: string }, text = 'prompt'): number {
  const turn = stub.session.events
    .filter(event => event.type === 'turn/start')
    .reduce((max, event) => Math.max(max, event.data.turn), 0) + 1
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: source as never,
  })
  stub.agent.inbox.append('next-turn', message)
  const claimed = stub.agent.inbox.claim('next-turn', turn)
  if (claimed.length === 0) throw new Error('expected queued turn input')
  stub.session.append('turn/start', { turn })
  for (const admitted of claimed) {
    stub.session.append('user/message', admitted, { surfaceOp: 'append' })
  }
  return turn
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  await ctx.plugin(ObjectiveRegistry)
  const fiber = await ctx.plugin(toolObjective)
  const root = stubAgent(ctx.sessions.create(SessionId(`objective-tool-root-${Math.random()}`)))
  ctx.agents.register(root.agent)
  return { ctx, fiber, root }
}

/** Execute one registered tool under the given agent as driver initiator. */
async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: Agent,
): Promise<ToolExecutionResult> {
  const run = () => ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  return agent === undefined ? run() : ctx.agents.withInitiator(agent, run)
}

/** Parse the compact JSON returned by a successful objective tool. */
function resultJson(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected objective tool success')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text tool result')
  const parsed = JSON.parse(block.text) as Record<string, unknown>
  expect(result.value).toEqual(parsed)
  return parsed
}

/** Read the returned objective sub-object. */
function resultObjective(result: ToolExecutionResult): Record<string, unknown> {
  const objective = resultJson(result)['objective']
  if (typeof objective !== 'object' || objective === null) throw new Error('expected returned objective')
  return objective as Record<string, unknown>
}

describe('objective tool registration and presentation', () => {
  it('registers four exclusive tools plus guidance and disposes all contributions', async () => {
    const { ctx, fiber } = await harness()
    const names = ['list_objectives', 'get_objective', 'create_objective', 'attach_objective']
    expect(names.map(name => ctx.tools.get(name)?.name)).toEqual(names)
    for (const name of names) {
      expect(ctx.tools.executionMode({ signal: testToolSignal, callId: CallId(name), name, arguments: {} }))
        .toEqual({ kind: 'exclusive' })
    }
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'tool:objective')
    expect(section?.text).toContain('cross-session intent containers')

    await fiber.dispose()
    expect(ctx.tools.get('list_objectives')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.some(item => item.name === 'tool:objective')).toBe(false)
  })

  it('uses args-only generic render intent and soft-fails malformed replay args', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.get('list_objectives')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'List objectives', kind: 'read',
    })
    expect(ctx.tools.get('get_objective')?.presentCall?.({ objective_id: 'objective-1' })).toEqual({
      card: 'generic', title: 'Read objective', kind: 'read', rawInput: 'objective-1',
    })
    expect(ctx.tools.get('create_objective')?.presentCall?.({ title: 'ship' })).toEqual({
      card: 'generic', title: 'Create objective', kind: 'other', rawInput: 'ship',
    })
    expect(ctx.tools.get('attach_objective')?.presentCall?.({ objective_id: 'objective-9' })).toEqual({
      card: 'generic', title: 'Attach to objective', kind: 'other', rawInput: 'objective-9',
    })
    expect(ctx.tools.get('create_objective')?.presentCall?.({ wrong: true })).toBeUndefined()
  })

  it('has the Loader-safe namespace export shape', () => {
    expect('default' in toolObjective).toBe(false)
    expect(toolObjective.name).toBe('tool-objective')
    expect(toolObjective.inject).toEqual(['agents', 'objectives', 'tools', 'systemPrompt'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(toolObjective)).toBe(toolObjective)
  })
})

describe('objective tool execution', () => {
  it('lists objectives and reads one back in full', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    expect(resultJson(await execute(ctx, 'list_objectives', {}, root.agent))).toEqual({ objectives: [] })
    const created = resultObjective(await execute(ctx, 'create_objective', {
      title: 'stabilize rulelift',
      north_star: 'no open P0s',
    }, root.agent))
    const listed = resultJson(await execute(ctx, 'list_objectives', {}, root.agent))['objectives']
    expect(listed).toEqual([{
      id: created['id'],
      title: 'stabilize rulelift',
      status: 'active',
      memberCount: 0,
      hasNorthStar: true,
      hasBrief: false,
    }])
    const detail = resultObjective(await execute(ctx, 'get_objective', {
      objective_id: created['id'],
    }, root.agent))
    expect(detail['northStar']).toBe('no open P0s')
    expect(detail['sessionIds']).toEqual([])
    // A stored brief is part of the detail value with its stamp.
    await ctx.objectives.setBrief(created['id'] as never, 'Six audits converge on P0s first.')
    const briefed = resultObjective(await execute(ctx, 'get_objective', {
      objective_id: created['id'],
    }, root.agent))
    expect(briefed['brief']).toBe('Six audits converge on P0s first.')
    expect(typeof briefed['briefAt']).toBe('string')
  })

  it('returns null for an unknown objective', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    expect(resultJson(await execute(ctx, 'get_objective', {
      objective_id: 'objective-void',
    }, root.agent))).toEqual({ objective: null })
  })

  it('attaches the calling session and records the membership event', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const created = resultObjective(await execute(ctx, 'create_objective', { title: 'convergence' }, root.agent))
    const attached = resultObjective(await execute(ctx, 'attach_objective', {
      objective_id: created['id'],
    }, root.agent))
    expect(attached['sessionIds']).toEqual([String(root.session.id)])
    const mirror = root.session.events[root.session.seq - 1]
    expect(mirror?.type).toBe('objective/member')
    // Idempotent re-attach through the tool.
    const again = resultObjective(await execute(ctx, 'attach_objective', {
      objective_id: created['id'],
    }, root.agent))
    expect(again['sessionIds']).toEqual([String(root.session.id)])
  })

  it('rejects create and attach outside a direct human turn', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'plugin' })
    for (const name of ['create_objective', 'attach_objective']) {
      const rejected = await execute(ctx, name, name === 'create_objective'
        ? { title: 'no' }
        : { objective_id: 'objective-1' }, root.agent)
      expect(rejected.isError).toBe(true)
      expect(rejected.error?.message).toContain('direct human turn')
    }
  })

  it('rejects calls without a calling agent', async () => {
    const { ctx } = await harness()
    const rejected = await execute(ctx, 'list_objectives', {})
    expect(rejected.isError).toBe(true)
    expect(rejected.error?.message).toContain('calling agent')
  })

  it('rejects a non-root child agent even with a human turn', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const child = stubAgent(ctx.sessions.create(SessionId(`objective-tool-child-${Math.random()}`)))
    ctx.agents.enter(child.agent, root.agent)
    ctx.agents.announce(child.agent)
    openTurn(child, { kind: 'user' })
    const rejected = await execute(ctx, 'create_objective', { title: 'no' }, child.agent)
    expect(rejected.isError).toBe(true)
    expect(rejected.error?.message).toContain('direct human turn')
  })

  it('rejects calls with no turn boundary at all', async () => {
    const { ctx, root } = await harness()
    const rejected = await execute(ctx, 'list_objectives', {}, root.agent)
    expect(rejected.isError).toBe(true)
    expect(rejected.error?.message).toContain('open model turn')
  })

  it('rejects a non-live agent and a closed turn', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    root.setStatus('idle')
    const idle = await execute(ctx, 'list_objectives', {}, root.agent)
    expect(idle.isError).toBe(true)
    root.setStatus('running')
    root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const closed = await execute(ctx, 'list_objectives', {}, root.agent)
    expect(closed.isError).toBe(true)
  })
})
