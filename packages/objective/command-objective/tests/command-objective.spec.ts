import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import ObjectiveRegistry from '@deepseek-ai/dsh-objective'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as commandObjective from '@deepseek-ai/dsh-command-objective'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Build one live idle agent accepted by the exact-identity command executor. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  // Store-created: membership attach mirrors its event on the durable log.
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

async function harness(config: commandObjective.Config = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  await ctx.plugin(ObjectiveRegistry)
  const plugin = await ctx.plugin(commandObjective, config)
  const { agent, session } = stubAgent(ctx, `objective-command-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, plugin }
}

/** Execute `/objective` through the same registry boundary as a UI adapter. */
async function run(test: Harness, suffix = ''): Promise<CommandResult> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/objective${suffix}`,
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('objective command was not registered')
  return execution.result
}

describe('@deepseek-ai/dsh-command-objective registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandObjective.name).toBe('command-objective')
    expect(commandObjective.inject).toEqual(['commands', 'objectives'])
    expect('default' in commandObjective).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandObjective)).toBe(commandObjective)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'objective',
      description: 'list or manage cross-session objectives',
      input: { hint: '[<title>|attach <id>|detach <id>|park <id>|reopen <id>|close <id>|delete <id>|brief <id>]' },
    })
    expect(test.ctx.commands.find(test.agent, 'objective')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'objective')).toBeUndefined()
  })

  it('fails invalid direct config before registering anything', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(ObjectiveRegistry)
    expect(() => {
      commandObjective.apply(ctx, { maxActiveObjectives: 1.5 })
    }).toThrow('positive safe integer')
  })
})

describe('/objective human command', () => {
  it('shows an empty overview with the WIP signal and usage', async () => {
    const test = await harness()
    await expect(run(test)).resolves.toEqual({
      kind: 'success',
      text: ['No objectives yet.', 'Active: 0/4', 'Usage: /objective [<title>|attach <id>|detach <id>|park <id>|reopen <id>|close <id>|delete <id>|brief <id>]'].join('\n'),
    })
  })

  it('creates an objective, lists it, and warns softly over the configured cap', async () => {
    const test = await harness({ maxActiveObjectives: 2 })
    const created = await run(test, ' stabilize rulelift')
    expect(created.kind).toBe('success')
    expect(created.text).toContain('Objective created\nStatus: active')
    expect(created.text).toContain('Objective: stabilize rulelift')
    await run(test, ' ship harness v1')
    const over = await run(test, ' third objective')
    expect(over.text).toContain('Active objectives exceed the configured cap (3/2)')
    const overview = await run(test)
    expect(overview.text).toContain('Active: 3/2')
    expect(overview.text).toContain('[A] stabilize rulelift — 0 sessions · ')
    expect(overview.text).toContain('[A] third objective')
  })

  it('parks, closes, and reopens by unique id prefix', async () => {
    const test = await harness()
    await run(test, ' one')
    await run(test, ' two')
    const first = test.ctx.objectives.list()[1]
    expect(first?.title).toBe('one')
    const hint = String(first?.id).slice(-8)
    const parked = await run(test, ` park ${hint}`)
    expect(parked.text).toContain('Status: parked')
    const afterPark = await run(test)
    expect(afterPark.text).toContain('[P]')
    const closed = await run(test, ` close ${hint}`)
    expect(closed.text).toContain('Status: closed')
    const overview = await run(test)
    expect(overview.text).toContain('[C]')
    await run(test, ` reopen ${hint}`)
    expect(test.ctx.objectives.get(first?.id as never)?.status).toBe('active')
  })

  it('attaches and detaches the commanding session and mirrors the event', async () => {
    const test = await harness()
    await run(test, ' convergence')
    const objective = test.ctx.objectives.list()[0]
    const hint = String(objective?.id).slice(-8)
    const attached = await run(test, ` attach ${hint}`)
    expect(attached.text).toContain('Session attached\nStatus: active')
    expect(test.ctx.objectives.objectivesOf(test.session.id)).toHaveLength(1)
    expect(test.session.events.some(event => event.type === 'objective/member')).toBe(true)
    const detached = await run(test, ` detach ${hint}`)
    expect(detached.text).toContain('Session detached')
    expect(test.ctx.objectives.objectivesOf(test.session.id)).toHaveLength(0)
  })

  it('shows a recorded brief with its stamp and a clear empty state', async () => {
    const test = await harness()
    await run(test, ' briefed work')
    const objective = test.ctx.objectives.list()[0]
    const hint = String(objective?.id).slice(-8)
    await expect(run(test, ` brief ${hint}`)).resolves.toMatchObject({
      kind: 'success',
      text: expect.stringContaining('No brief recorded'),
    })
    await test.ctx.objectives.setBrief(objective?.id as never, 'Six audits converge on P0s first.')
    const shown = await run(test, ` brief ${hint}`)
    expect(shown.text).toContain('Six audits converge on P0s first.')
    expect(shown.text).toContain('recorded 20')
  })

  it('deletes by id prefix and reports unknown and ambiguous prefixes', async () => {
    const test = await harness()
    await run(test, ' doomed')
    const objective = test.ctx.objectives.list()[0]
    const hint = String(objective?.id).slice(-8)
    const deleted = await run(test, ` delete ${hint}`)
    expect(deleted).toEqual({ kind: 'success', text: 'Objective deleted: doomed' })
    await expect(run(test)).resolves.toMatchObject({ text: expect.stringContaining('No objectives yet.') })

    await run(test, ' alpha')
    await run(test, ' beta')
    const absent = await run(test, ' attach nope')
    expect(absent.kind).toBe('error')
    expect(absent.text).toContain("No objective id matches 'nope'")
    const short = await run(test, ' delete e')
    expect(short.kind).toBe('error')
    expect(short.text).toContain("matches several objectives")
  })

  it('rejects id actions without an id and unknown-objective mutations through the domain', async () => {
    const test = await harness()
    const bare = await run(test, ' attach')
    expect(bare.kind).toBe('error')
    expect(bare.text).toContain('/objective attach requires an objective id.')
    const missing = await run(test, ' delete ffffffff')
    expect(missing.kind).toBe('error')
    expect(missing.text).toContain('No objective id matches')
  })
})
