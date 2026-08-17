import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import ObjectiveRegistry, { ObjectiveError, ObjectiveId } from '@deepseek-ai/dsh-objective'
import type { ObjectiveView } from '@deepseek-ai/dsh-objective'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import * as objectiveSynthesizer from '@deepseek-ai/dsh-objective-synthesizer'

/** What the fake provider captured for one start, plus its disposal count. */
interface CapturedStart {
  promptText: string
  outputSchema: unknown
  maxDepth: number | undefined
  disposed: number
}

/** One scriptable in-process provider satisfying the one-shot contract. */
class ScriptedProvider implements SubagentProvider {
  readonly name = 'synth-test'
  readonly capabilities = { outputSchema: true, depthLimit: true, toolFilter: false, persona: false }
  readonly inheritsParentContext = false
  captured: CapturedStart | undefined
  result: SubagentResult = {
    output: [],
    structured: { brief: 'Six audits converge on P0s first.', openQuestions: ['Fund the P0 fix now?'] },
    stopReason: 'completed',
  }

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.captured = {
      promptText: request.prompt.map(block => block.type === 'text' ? block.text : '').join('\n'),
      outputSchema: request.outputSchema,
      maxDepth: request.maxDepth,
      disposed: 0,
    }
    const captured = this.captured
    const run: SubagentRun = {
      id: SessionId('synth-child'),
      localAgent: undefined,
      result: Promise.resolve(this.result),
      dispose: async () => { captured.disposed += 1 },
    }
    return Promise.resolve(run)
  }
}

/** Build one live idle agent for command-scope delegation. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
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

/** One recorded member log: a boundary event plus assistant conclusions. */
function memberSnapshot(texts: readonly string[]): { header: unknown; events: unknown[] } {
  return {
    header: { version: 0, id: SessionId('member'), createdAt: 0 },
    events: [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      ...texts.map((text, index) => ({
        type: 'assistant/message',
        seq: index + 1,
        time: 0,
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
      })),
    ],
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly provider: ScriptedProvider
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
  readonly snapshots: Map<string, { header: unknown; events: unknown[] }>
}

async function harness(
  provider = new ScriptedProvider(),
  config: Record<string, unknown> = {},
): Promise<Harness> {
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
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider(provider)
  const snapshots = new Map<string, { header: unknown; events: unknown[] }>()
  ctx.provide('sessionQuery', {
    readSession: async (id: SessionId) => {
      const snapshot = snapshots.get(String(id))
      if (snapshot === undefined) throw new Error(`no snapshot scripted for ${String(id)}`)
      return snapshot
    },
  } as never)
  const plugin = await ctx.plugin(objectiveSynthesizer, { provider: 'synth-test', ...config })
  const { agent, session } = stubAgent(ctx, `synth-root-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, provider, plugin, snapshots }
}

/** One objective with scripted member material already attached. */
async function objectiveWithMembers(
  test: Harness,
  texts: readonly string[],
): Promise<ObjectiveView> {
  const objective = await test.ctx.objectives.create({ title: 'stabilize rulelift', northStar: 'no open P0s' })
  const member = test.ctx.sessions.create(SessionId(`member-${Math.random()}`))
  test.snapshots.set(String(member.id), memberSnapshot(texts))
  return await test.ctx.objectives.attachSession(objective.id, member.id)
}

/** Execute `/synthesize` through the registry boundary. */
async function run(test: Harness, suffix = ''): Promise<CommandResult> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/synthesize${suffix}`,
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('synthesize command was not registered')
  return execution.result
}

describe('@deepseek-ai/dsh-objective-synthesizer registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(objectiveSynthesizer.name).toBe('objective-synthesizer')
    expect(objectiveSynthesizer.inject).toEqual(['commands', 'objectives', 'sessionQuery', 'subagents'])
    expect('default' in objectiveSynthesizer).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(objectiveSynthesizer)).toBe(objectiveSynthesizer)
    expect(test.ctx.commands.find(test.agent, 'synthesize')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'synthesize')).toBeUndefined()
  })
})

describe('/synthesize delegation', () => {
  it('stores the structured brief and renders open questions into it', async () => {
    const test = await harness()
    const objective = await objectiveWithMembers(test, ['first pass found noise', 'second pass confirmed P0 set'])
    const stored = await run(test, ` ${String(objective.id).slice(-8)}`)
    expect(stored.kind).toBe('success')
    expect(stored.text).toContain('Brief stored for stabilize rulelift')
    expect(stored.text).toContain('Six audits converge on P0s first.')
    expect(stored.text).toContain('Open questions:')
    expect(stored.text).toContain('- Fund the P0 fix now?')
    const view = test.ctx.objectives.get(objective.id)
    expect(view?.briefAt).toBeDefined()
  })

  it('delegates with the stable instruction, material tail, schema, and zero depth', async () => {
    const test = await harness()
    const texts = ['one', 'two', 'three', 'four', 'five']
    const objective = await objectiveWithMembers(test, texts)
    await run(test, ` ${String(objective.id).slice(-8)}`)
    const captured = test.provider.captured
    expect(captured).toBeDefined()
    if (captured === undefined) throw new Error('provider saw no start')
    expect(captured.promptText).toContain('You are the synthesis step for one cross-session objective.')
    expect(captured.promptText).toContain('Objective: stabilize rulelift')
    expect(captured.promptText).toContain('North star: no open P0s')
    // Only the trailing three assistant conclusions ride along.
    expect(captured.promptText).toContain('- three')
    expect(captured.promptText).toContain('- five')
    expect(captured.promptText).not.toContain('- one\n')
    expect(captured.maxDepth).toBe(0)
    expect(captured.outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['brief', 'openQuestions'],
      properties: {
        brief: { type: 'string' },
        openQuestions: { type: 'array', items: { type: 'string' } },
      },
    })
    expect(captured.disposed).toBe(1)
  })

  it('rejects an objective with no member sessions', async () => {
    const test = await harness()
    const objective = await test.ctx.objectives.create({ title: 'empty' })
    const rejected = await run(test, ` ${String(objective.id).slice(-8)}`)
    expect(rejected.kind).toBe('error')
    expect(rejected.text).toContain('Synthesis failed: objective \'empty\' has no member sessions')
  })

  it('rejects a failed child and a missing structured result', async () => {
    const failing = new ScriptedProvider()
    failing.result = { output: [], stopReason: 'error' }
    const test = await harness(failing)
    const objective = await objectiveWithMembers(test, ['material'])
    const failed = await run(test, ` ${String(objective.id).slice(-8)}`)
    expect(failed.text).toContain('Synthesis failed: the synthesis child ended with stop reason "error"')

    const silent = new ScriptedProvider()
    silent.result = { output: [], stopReason: 'completed' }
    const test2 = await harness(silent)
    const objective2 = await objectiveWithMembers(test2, ['material'])
    const missing = await run(test2, ` ${String(objective2.id).slice(-8)}`)
    expect(missing.text).toContain('Synthesis failed: the synthesis child returned no structured result')

    const malformed = new ScriptedProvider()
    malformed.result = { output: [], structured: { brief: 42, openQuestions: [] }, stopReason: 'completed' }
    const test3 = await harness(malformed)
    const objective3 = await objectiveWithMembers(test3, ['material'])
    const broken = await run(test3, ` ${String(objective3.id).slice(-8)}`)
    expect(broken.text).toContain('Synthesis failed: the synthesis child returned a malformed structured result')
  })

  it('rejects an unknown objective through the domain error', async () => {
    const test = await harness()
    const rejected = await run(test, ' ffffffff')
    expect(rejected.kind).toBe('error')
    expect(rejected.text).toContain('No objective id matches')
    await expect(objectiveSynthesizer.synthesizeObjective(
      test.ctx,
      objectiveSynthesizer.resolveConfig({ provider: 'synth-test' }),
      test.agent,
      ObjectiveId('objective-void'),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(ObjectiveError)
  })

  it('reports ambiguous and empty fragments and truncates long material', async () => {
    const test = await harness()
    await test.ctx.objectives.create({ title: 'alpha' })
    await test.ctx.objectives.create({ title: 'beta' })
    const ambiguous = await run(test, ' e')
    expect(ambiguous.kind).toBe('error')
    expect(ambiguous.text).toContain('matches several objectives')
    const bare = await run(test)
    expect(bare.kind).toBe('error')
    expect(bare.text).toBe('Usage: /synthesize <objective id>')

    const long = await harness()
    const objective = await objectiveWithMembers(long, ['x'.repeat(3000)])
    const stored = await run(long, ` ${String(objective.id).slice(-8)}`)
    expect(stored.kind).toBe('success')
    const captured = long.provider.captured
    expect(captured?.promptText).toContain('…')
  })

  it('stores a question-free brief verbatim and notes member logs without conclusions', async () => {
    const quiet = new ScriptedProvider()
    quiet.result = { output: [], structured: { brief: 'Nothing has landed yet.', openQuestions: [] }, stopReason: 'completed' }
    const test = await harness(quiet)
    // A whitespace-only assistant conclusion is skipped, not recorded.
    const objective = await objectiveWithMembers(test, ['  '])
    const stored = await run(test, ` ${String(objective.id).slice(-8)}`)
    expect(stored.kind).toBe('success')
    expect(stored.text).toContain('Nothing has landed yet.')
    expect(stored.text).not.toContain('Open questions:')
    expect(test.provider.captured?.promptText).toContain('(no recorded assistant conclusions)')
    expect(test.ctx.objectives.get(objective.id)?.brief).toBe('Nothing has landed yet.')

    // Blank questions drop out instead of rendering empty list items.
    const filtered = new ScriptedProvider()
    filtered.result = { output: [], structured: { brief: 'Two tracks.', openQuestions: ['', '  ', 'Which first?'] }, stopReason: 'completed' }
    const test2 = await harness(filtered)
    const objective2 = await objectiveWithMembers(test2, ['material'])
    const stored2 = await run(test2, ` ${String(objective2.id).slice(-8)}`)
    expect(stored2.text).toContain('- Which first?')
    expect(stored2.text?.split('- ').length).toBe(2)
  })

  it('skips a non-active objective and honors configured material limits', async () => {
    const test = await harness()
    const objective = await objectiveWithMembers(test, ['material'])
    await test.ctx.objectives.update(objective.id, { status: 'parked' })
    const parked = await run(test, ` ${String(objective.id).slice(-8)}`)
    expect(parked.kind).toBe('error')
    expect(parked.text).toContain('is parked; the synthesizer skips non-active objectives')
    expect(test.provider.captured).toBeUndefined()

    // materialTail config trims each member's contribution to the last message.
    const tight = new ScriptedProvider()
    tight.result = { output: [], structured: { brief: 'One track only.', openQuestions: [] }, stopReason: 'completed' }
    const test2 = await harness(tight, { materialTail: 1 })
    const objective2 = await test2.ctx.objectives.create({ title: 'tight' })
    const member2 = test2.ctx.sessions.create(SessionId('member-tight'))
    test2.snapshots.set(String(member2.id), memberSnapshot(['old', 'new']))
    await test2.ctx.objectives.attachSession(objective2.id, member2.id)
    const stored = await run(test2, ` ${String(objective2.id).slice(-8)}`)
    expect(stored.kind).toBe('success')
    expect(tight.captured?.promptText).toContain('- new')
    expect(tight.captured?.promptText).not.toContain('- old')
  })

  it('applies with no config at all and rejects invalid limits', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    expect(() => { objectiveSynthesizer.apply(ctx) }).not.toThrow()
    expect(() => { objectiveSynthesizer.resolveConfig({ provider: '' }) }).toThrow('non-empty string')
    expect(() => { objectiveSynthesizer.resolveConfig({ materialTail: 0 }) }).toThrow('positive safe integer')
    expect(() => { objectiveSynthesizer.resolveConfig({ messageCapChars: 10 }) }).toThrow('at least 200')
  })

  it('rethrows infrastructure faults loudly', async () => {
    const test = await harness()
    const objective = await objectiveWithMembers(test, ['material'])
    await expect(run(test, ` ${String(objective.id).slice(-8)}`)).resolves.toBeDefined()
    // An unregistered provider name is an infrastructure fault: it rethrows.
    const missing = new Context()
    await missing.plugin(AgentRegistry)
    await missing.plugin(CommandRuntime)
    await missing.plugin(Storage)
    missing.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(missing, { backend: 'memory', routes: {} })
    missing.storage.mount('domain', facility)
    missing.provide('storageDomain', facility)
    await missing.plugin(SessionStore)
    await missing.plugin(ObjectiveRegistry)
    await missing.plugin(SubagentRuntime)
    missing.provide('sessionQuery', {
      readSession: async () => memberSnapshot(['material']),
    } as never)
    await missing.plugin(objectiveSynthesizer, { provider: 'not-registered' })
    const { agent } = stubAgent(missing, 'synth-missing')
    missing.agents.register(agent)
    const objective2 = await missing.objectives.create({ title: 'ghost provider' })
    const member2 = missing.sessions.create(SessionId('member-ghost'))
    await missing.objectives.attachSession(objective2.id, member2.id)
    await expect(missing.commands.execute(
      agent,
      `/synthesize ${String(objective2.id).slice(-8)}`,
      new AbortController().signal,
    )).rejects.toThrow()
  })
})
