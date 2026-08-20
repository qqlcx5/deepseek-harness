import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import DecisionRegistry, { DecisionError } from '@deepseek-ai/dsh-decision'
import ObjectiveRegistry from '@deepseek-ai/dsh-objective'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import * as decisionDrafter from '@deepseek-ai/dsh-decision-drafter'

/** What the fake provider captured for one start, plus its disposal count. */
interface CapturedStart {
  promptText: string
  maxDepth: number | undefined
  disposed: number
}

/** One scriptable in-process provider satisfying the one-shot contract. */
class ScriptedProvider implements SubagentProvider {
  readonly name = 'draft-test'
  readonly capabilities = { outputSchema: true, depthLimit: true, toolFilter: false, persona: false }
  readonly inheritsParentContext = false
  captured: CapturedStart | undefined
  result: SubagentResult = {
    output: [],
    structured: {
      options: [
        { label: 'repair', evidence: 'cheapest path', cost: '3 days' },
        { label: 'rewrite', evidence: 'removes the bug class', risk: 'regression window' },
      ],
      recommendation: 'repair',
      rationale: 'lowest cost now',
      confidence: 0.7,
      counterEvidence: 'rewrite removes the whole class of bugs; repair does not',
      reversibility: 'costly',
    },
    stopReason: 'completed',
  }

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.captured = {
      promptText: request.prompt.map(block => block.type === 'text' ? block.text : '').join('\n'),
      maxDepth: request.maxDepth,
      disposed: 0,
    }
    const captured = this.captured
    const run: SubagentRun = {
      id: SessionId('draft-child'),
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

/** One recorded member log for the fake session-query service. */
function memberSnapshot(texts: readonly string[]): unknown {
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
  readonly snapshots: Map<string, unknown>
}

async function harness(provider = new ScriptedProvider()): Promise<Harness> {
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
  await ctx.plugin(DecisionRegistry)
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider(provider)
  const snapshots = new Map<string, unknown>()
  ctx.provide('sessionQuery', {
    readSession: async (id: SessionId) => {
      const snapshot = snapshots.get(String(id))
      if (snapshot === undefined) throw new Error(`no snapshot scripted for ${String(id)}`)
      return snapshot
    },
  } as never)
  const plugin = await ctx.plugin(decisionDrafter, { provider: 'draft-test' })
  const { agent, session } = stubAgent(ctx, `draft-root-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, provider, plugin, snapshots }
}

/** Execute `/decide-draft` through the registry boundary. */
async function run(test: Harness, suffix = ''): Promise<CommandResult> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/decide-draft${suffix}`,
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('decide-draft command was not registered')
  return execution.result
}

/** An objective with a brief, a scripted member, and its id hint. */
async function objectiveWithBrief(
  test: Harness,
  brief: string | undefined,
): Promise<{ hint: string }> {
  const objective = await test.ctx.objectives.create({ title: 'stabilize rulelift', northStar: 'no open P0s' })
  if (brief !== undefined) await test.ctx.objectives.setBrief(objective.id, brief)
  const member = test.ctx.sessions.create(SessionId(`member-${Math.random()}`))
  test.snapshots.set(String(member.id), memberSnapshot(['audit three found the P0 set']))
  await test.ctx.objectives.attachSession(objective.id, member.id)
  return { hint: String(objective.id).slice(-8) }
}

describe('@deepseek-ai/dsh-decision-drafter registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(decisionDrafter.name).toBe('decision-drafter')
    expect(decisionDrafter.inject).toEqual(['commands', 'decisions', 'objectives', 'sessionQuery', 'subagents'])
    expect('default' in decisionDrafter).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(decisionDrafter)).toBe(decisionDrafter)
    expect(test.ctx.commands.find(test.agent, 'decide-draft')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'decide-draft')).toBeUndefined()
  })
})

describe('/decide-draft delegation', () => {
  it('drafts the card with counter-evidence and anchors on the objective material', async () => {
    const test = await harness()
    const objective = await objectiveWithBrief(test, 'Six audits converge on fixing P0s first.')
    const linked = await test.ctx.decisions.create({ question: 'Repair rulelift or rewrite it?' })
    const outcome = await run(test, ` ${String(linked.id).slice(-8)} ${objective.hint}`)
    expect(outcome.kind).toBe('success')
    expect(outcome.text).toContain('Card drafted for: Repair rulelift or rewrite it?')
    expect(outcome.text).toContain("recommendation 'repair' (confidence 0.7)")
    expect(outcome.text).toContain('Counter-evidence section: recorded')

    const view = test.ctx.decisions.get(linked.id)
    expect(view?.options).toHaveLength(2)
    expect(view?.counterEvidence).toContain('rewrite removes the whole class')
    expect(view?.reversibility).toBe('costly')

    const captured = test.provider.captured
    expect(captured).toBeDefined()
    if (captured === undefined) throw new Error('provider saw no start')
    expect(captured.promptText).toContain('You are the drafting step for one strategic decision.')
    expect(captured.promptText).toContain('Question: Repair rulelift or rewrite it?')
    expect(captured.promptText).toContain('Objective: stabilize rulelift')
    expect(captured.promptText).toContain('Six audits converge on fixing P0s first.')
    expect(captured.promptText).toContain('- audit three found the P0 set')
    expect(captured.maxDepth).toBe(0)
    expect(captured.disposed).toBe(1)
  })

  it('drafts without an objective and without member material', async () => {
    const test = await harness()
    const decision = await test.ctx.decisions.create({ question: 'Lunch venue?' })
    const outcome = await run(test, ` ${String(decision.id).slice(-8)}`)
    expect(outcome.kind).toBe('success')
    const captured = test.provider.captured
    expect(captured?.promptText).toContain('Question: Lunch venue?')
    expect(captured?.promptText).toContain('(no member-session material available)')
    expect(captured?.promptText).not.toContain('Objective:')
  })

  it('drafts through a linked ghost objective and a memberless objective', async () => {
    const test = await harness()
    // The decision links an objective id that no longer resolves: drafting
    // proceeds with no objective context rather than failing.
    const ghost = await test.ctx.decisions.create({
      question: 'Ghosted?',
      objectiveId: (await import('@deepseek-ai/dsh-objective')).ObjectiveId('objective-ghost'),
    })
    const ghostOutcome = await run(test, ` ${String(ghost.id).slice(-8)}`)
    expect(ghostOutcome.kind).toBe('success')
    const ghostPrompt = test.provider.captured?.promptText
    expect(ghostPrompt).toContain('Question: Ghosted?')
    expect(ghostPrompt).not.toContain('Objective:')

    // An objective with no member sessions contributes its title but no material rows.
    const bare = await test.ctx.objectives.create({ title: 'bare' })
    const bareDecision = await test.ctx.decisions.create({ question: 'Bare?' })
    const bareOutcome = await run(test, ` ${String(bareDecision.id).slice(-8)} ${String(bare.id).slice(-8)}`)
    expect(bareOutcome.kind).toBe('success')
    const barePrompt = test.provider.captured?.promptText
    expect(barePrompt).toContain('Objective: bare')
    expect(barePrompt).toContain('(no member-session material available)')
  })

  it('drafts from an objective without a brief but with material', async () => {
    const test = await harness()
    const objective = await objectiveWithBrief(test, undefined)
    const decision = await test.ctx.decisions.create({ question: 'Ship Friday?' })
    const outcome = await run(test, ` ${String(decision.id).slice(-8)} ${objective.hint}`)
    expect(outcome.kind).toBe('success')
    const captured = test.provider.captured
    expect(captured?.promptText).not.toContain('Objective brief:')
    expect(captured?.promptText).toContain('- audit three found the P0 set')
  })

  it('rejects drafting a decided decision', async () => {
    const test = await harness()
    const decision = await test.ctx.decisions.create({
      question: 'Closed?',
      options: [{ label: 'yes', evidence: 'done' }],
    })
    await test.ctx.decisions.decide(decision.id, 'yes')
    const rejected = await run(test, ` ${String(decision.id).slice(-8)}`)
    expect(rejected.kind).toBe('error')
    expect(rejected.text).toContain('only an open decision accepts a draft')
    expect(test.provider.captured).toBeUndefined()
  })

  it('rejects a failed child and missing or malformed structured results', async () => {
    const failing = new ScriptedProvider()
    failing.result = { output: [], stopReason: 'error' }
    const test1 = await harness(failing)
    const decision1 = await test1.ctx.decisions.create({ question: 'q1' })
    const failed = await run(test1, ` ${String(decision1.id).slice(-8)}`)
    expect(failed.text).toContain('Drafting failed: the drafting child ended with stop reason "error"')

    const silent = new ScriptedProvider()
    silent.result = { output: [], stopReason: 'completed' }
    const test2 = await harness(silent)
    const decision2 = await test2.ctx.decisions.create({ question: 'q2' })
    const missing = await run(test2, ` ${String(decision2.id).slice(-8)}`)
    expect(missing.text).toContain('Drafting failed: the drafting child returned no structured result')

    const malformed = new ScriptedProvider()
    malformed.result = {
      output: [],
      structured: { options: [{ label: '', evidence: 'x' }], recommendation: 'r', rationale: 'a', confidence: 2, counterEvidence: '', reversibility: 'reversible' },
      stopReason: 'completed',
    }
    const test3 = await harness(malformed)
    const decision3 = await test3.ctx.decisions.create({ question: 'q3' })
    const broken = await run(test3, ` ${String(decision3.id).slice(-8)}`)
    expect(broken.text).toContain('Drafting failed: the drafting child returned a malformed structured result')

    const hostile = new ScriptedProvider()
    hostile.result = {
      output: [],
      structured: { options: [42], recommendation: 'r', rationale: 'a', confidence: 0.5, counterEvidence: '', reversibility: 'reversible' },
      stopReason: 'completed',
    }
    const test4 = await harness(hostile)
    const decision4 = await test4.ctx.decisions.create({ question: 'q4' })
    const hostileResult = await run(test4, ` ${String(decision4.id).slice(-8)}`)
    expect(hostileResult.text).toContain('malformed structured result')

    const wrongReversibility = new ScriptedProvider()
    wrongReversibility.result = {
      output: [],
      structured: { options: [{ label: 'a', evidence: 'e' }], recommendation: 'a', rationale: 'r', confidence: 0.5, counterEvidence: '', reversibility: 'nope' },
      stopReason: 'completed',
    }
    const test5 = await harness(wrongReversibility)
    const decision5 = await test5.ctx.decisions.create({ question: 'q5' })
    const triage = await run(test5, ` ${String(decision5.id).slice(-8)}`)
    expect(triage.text).toContain('malformed structured result')

    const honest = new ScriptedProvider()
    honest.result = {
      output: [],
      structured: { options: [{ label: 'a', evidence: 'e' }], recommendation: 'a', rationale: 'r', confidence: 0.5, counterEvidence: '', reversibility: 'reversible' },
      stopReason: 'completed',
    }
    const test6 = await harness(honest)
    const decision6 = await test6.ctx.decisions.create({ question: 'q6' })
    const emptyCounter = await run(test6, ` ${String(decision6.id).slice(-8)}`)
    expect(emptyCounter.text).toContain('Counter-evidence section: (empty)')
  })

  it('reports unknown and ambiguous decision and objective fragments and bare usage', async () => {
    const test = await harness()
    await test.ctx.decisions.create({ question: 'alpha' })
    await test.ctx.decisions.create({ question: 'beta' })
    const bare = await run(test)
    expect(bare.kind).toBe('error')
    expect(bare.text).toBe('Usage: /decide-draft <decision id> [objective id]')
    const absent = await run(test, ' ffffffff')
    expect(absent.text).toContain('No decision id matches')
    const ambiguous = await run(test, ' e')
    expect(ambiguous.text).toContain('matches several decisions')
    const decision = test.ctx.decisions.list()[0]
    const badObjective = await run(test, ` ${String(decision?.id).slice(-8)} ffffffff`)
    expect(badObjective.text).toContain('No objective id matches')
  })

  it('applies with no config and rejects invalid limits', () => {
    expect(() => { decisionDrafter.resolveConfig({}) }).not.toThrow()
    expect(decisionDrafter.resolveConfig({}).provider).toBe('spawn')
    expect(() => { decisionDrafter.resolveConfig({ provider: '' }) }).toThrow('non-empty string')
    expect(() => { decisionDrafter.resolveConfig({ materialTail: 0 }) }).toThrow('positive safe integer')
    expect(() => { decisionDrafter.resolveConfig({ messageCapChars: 5 }) }).toThrow('at least 200')
  })

  it('rejects unknown decisions through the domain error and rethrows foreign faults', async () => {
    const test = await harness()
    await expect(decisionDrafter.draftDecision(
      test.ctx,
      decisionDrafter.resolveConfig({ provider: 'draft-test' }),
      test.agent,
      (await import('@deepseek-ai/dsh-decision')).DecisionId('decision-void'),
      undefined,
      new AbortController().signal,
    )).rejects.toBeInstanceOf(DecisionError)

    await test.ctx.decisions.create({ question: 'resilient' })
    const foreign = vi.spyOn(test.ctx.decisions, 'update')
      .mockRejectedValue(new Error('medium offline'))
    await expect(run(test, ' e')).rejects.toThrow('medium offline')
    foreign.mockRestore()
  })
})
