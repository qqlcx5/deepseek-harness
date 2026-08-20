import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import DecisionRegistry from '@deepseek-ai/dsh-decision'
import ObjectiveRegistry from '@deepseek-ai/dsh-objective'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as commandDecision from '@deepseek-ai/dsh-command-decision'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Build one live idle agent accepted by the command executor. */
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

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  await ctx.plugin(DecisionRegistry)
  const plugin = await ctx.plugin(commandDecision)
  const { agent, session } = stubAgent(ctx, `decide-command-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, plugin }
}

/** Execute `/decide` through the same registry boundary as a UI adapter. */
async function run(test: Harness, suffix = ''): Promise<CommandResult> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/decide${suffix}`,
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('decide command was not registered')
  return execution.result
}

/** The id fragment for the first decision in registry order. */
function firstHint(test: Harness): string {
  const decision = test.ctx.decisions.list()[0]
  if (decision === undefined) throw new Error('no decision to address')
  return String(decision.id).slice(-8)
}

describe('@deepseek-ai/dsh-command-decision registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandDecision.name).toBe('command-decision')
    expect(commandDecision.inject).toEqual(['commands', 'decisions'])
    expect('default' in commandDecision).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandDecision)).toBe(commandDecision)
    expect(test.ctx.commands.find(test.agent, 'decide')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'decide')).toBeUndefined()
  })
})

describe('/decide human command', () => {
  it('shows an empty overview with usage', async () => {
    const test = await harness()
    await expect(run(test)).resolves.toEqual({
      kind: 'success',
      text: ['No decisions yet.', 'Usage: /decide [<question>|show <id>|choose <id> <option>|rev <id> <outcome>|super <id>|delete <id>]'].join('\n'),
    })
  })

  it('creates a decision and renders the card with the explicit empty counter-evidence', async () => {
    const test = await harness()
    const created = await run(test, ' Rewrite or repair rulelift?')
    expect(created.kind).toBe('success')
    expect(created.text).toContain('Decision created')
    expect(created.text).toContain('Question: Rewrite or repair rulelift?')
    expect(created.text).toContain('(no options drafted yet)')
    expect(created.text).toContain('Counter-evidence:')
    expect(created.text).toContain('(none recorded — the card says so explicitly, absence is not silent)')
    const overview = await run(test)
    expect(overview.text).toContain('[O] Rewrite or repair rulelift? — 0 options · ')
  })

  it('drafts options through the service, then chooses with validation', async () => {
    const test = await harness()
    const decision = await test.ctx.decisions.create({ question: 'Fund the fix?' })
    await test.ctx.decisions.update(decision.id, {
      options: [
        { label: 'repair', evidence: 'cheap, local', cost: '3 days' },
        { label: 'rewrite', evidence: 'removes bug class', risk: 'regression window' },
      ],
      recommendation: 'repair',
      rationale: 'lowest cost now',
      confidence: 0.7,
      counterEvidence: 'rewrite removes the whole class of bugs; repair does not',
    })
    const hint = String(decision.id).slice(-8)
    const card = await run(test, ` show ${hint}`)
    expect(card.text).toContain('- repair: cheap, local')
    expect(card.text).toContain('cost: 3 days')
    expect(card.text).toContain('risk: regression window')
    expect(card.text).toContain('Recommendation: repair (confidence 0.7)')
    expect(card.text).toContain('rewrite removes the whole class')

    const bad = await run(test, ` choose ${hint} nope`)
    expect(bad.kind).toBe('error')
    expect(bad.text).toContain('not valid for the current state')

    const chosen = await run(test, ` choose ${hint} repair`)
    expect(chosen.text).toContain('Decision made')
    expect(chosen.text).toContain('Chosen: repair (frozen at 0.7)')
    const overview = await run(test)
    expect(overview.text).toContain('[D] Fund the fix? — → repair · ')
  })

  it('reminds about due-unreviewed decisions and clears the reminder after a review', async () => {
    const test = await harness()
    const decision = await test.ctx.decisions.create({
      question: 'Ship Friday?',
      options: [{ label: 'yes', evidence: 'fixed scope' }],
      dueAt: new Date(Date.now() - 1000).toISOString(),
    })
    const hint = String(decision.id).slice(-8)
    // Open decisions are never due; decide first.
    await expect(run(test, ' show ffffffff')).resolves.toMatchObject({ kind: 'error' })
    await test.ctx.decisions.decide(decision.id, 'yes')
    const due = await run(test)
    expect(due.text).toContain('Due for review (1):')
    expect(due.text).toContain(`/decide rev ${hint} <outcome>`)

    const review = await run(test, ` rev ${hint} Shipped clean; no incidents`)
    expect(review.kind).toBe('success')
    expect(review.text).toContain('Prediction: no frozen prediction')
    expect(review.text).toContain('Outcome: Shipped clean; no incidents')
    const cleared = await run(test)
    expect(cleared.text).not.toContain('Due for review')
  })

  it('supersedes and deletes by fragment and reports ambiguous or absent ids', async () => {
    const test = await harness()
    await run(test, ' doomed')
    await run(test, ' keeper')
    const doomed = test.ctx.decisions.list()[1]
    const hint = String(doomed?.id).slice(-8)
    const superseded = await run(test, ` super ${hint}`)
    expect(superseded.text).toContain('Decision superseded')
    expect((await run(test)).text).toContain('[S] doomed — superseded · ')

    const deleted = await run(test, ` delete ${hint}`)
    expect(deleted).toEqual({ kind: 'success', text: 'Decision deleted: doomed (review trail kept)' })
    await expect(run(test, ` delete ${hint}`)).resolves.toMatchObject({
      kind: 'error',
      text: expect.stringContaining('No decision id matches') as unknown as string,
    })

    await run(test, ' alpha')
    await run(test, ' beta')
    const ambiguous = await run(test, ' show e')
    expect(ambiguous.kind).toBe('error')
    expect(ambiguous.text).toContain('matches several decisions')
  })

  it('gates an irreversible decision behind a confirming second pass with a stamp', async () => {
    const test = await harness()
    const decision = await test.ctx.decisions.create({
      question: 'Delete the production dataset?',
      reversibility: 'irreversible',
      options: [
        { label: 'delete', evidence: 'migration is complete' },
        { label: 'keep', evidence: 'rollback safety' },
      ],
    })
    await test.ctx.decisions.update(decision.id, {
      counterEvidence: 'restore takes 40 minutes and has failed once in staging',
    })
    const hint = String(decision.id).slice(-8)
    const first = await run(test, ` choose ${hint} delete`)
    expect(first.kind).toBe('error')
    expect(first.text).toContain('This decision is IRREVERSIBLE.')
    expect(first.text).toContain('restore takes 40 minutes')
    expect(first.text).toContain(`Confirm with: /decide choose ${hint} delete confirm `)

    // A wrong stamp on the confirming pass is a stale card, not a decision.
    const stale = await run(test, ` choose ${hint} delete confirm 2000-01-01T00:00:00.000Z`)
    expect(stale.kind).toBe('error')
    expect(stale.text).toContain('The card changed since the stamp')

    // The card really changing under the confirming pass rejects too.
    await test.ctx.decisions.update(decision.id, { counterEvidence: 'rest tooling has since improved' })
    const reRead = test.ctx.decisions.get(decision.id)
    const changed = await run(test, ` choose ${hint} delete confirm ${reRead?.updatedAt === decision.updatedAt ? '2001-01-01T00:00:00.000Z' : decision.updatedAt}`)
    expect(changed.kind).toBe('error')
    expect(changed.text).toContain('changed since the stamp')

    // The fresh stamp confirms.
    const fresh = test.ctx.decisions.get(decision.id)
    const confirmed = await run(test, ` choose ${hint} delete confirm ${fresh?.updatedAt}`)
    expect(confirmed.kind).toBe('success')
    expect(confirmed.text).toContain('Decision made')
  })

  it('marks decisions whose objective link dangles or parks, silently without the objective service', async () => {
    const test = await harness()
    // Without the objective service composed, the marker stays silent.
    const ghostLinked = await test.ctx.decisions.create({
      question: 'linked to nothing?',
      objectiveId: (await import('@deepseek-ai/dsh-objective')).ObjectiveId('objective-ghost'),
    })
    const plain = await run(test)
    expect(plain.text).not.toContain('(!)')
    void ghostLinked

    // With the objective group composed: active links stay unmarked, dangling
    // and parked ones are flagged.
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
    await ctx.plugin(commandDecision)
    const { agent } = stubAgent(ctx, 'decide-markers')
    ctx.agents.register(agent)
    const active = await ctx.objectives.create({ title: 'active one' })
    const parked = await ctx.objectives.create({ title: 'parked one' })
    await ctx.objectives.update(parked.id, { status: 'parked' })
    const linked = await ctx.decisions.create({
      question: 'linked fine?',
      objectiveId: active.id,
      options: [{ label: 'ok', evidence: 'e' }],
    })
    await ctx.decisions.create({ question: 'parked link?', objectiveId: parked.id })
    await ctx.decisions.create({ question: 'dangling link?', objectiveId: (await import('@deepseek-ai/dsh-objective')).ObjectiveId('objective-void') })
    const execution = await ctx.commands.execute(agent, '/decide', new AbortController().signal)
    const text = (execution?.result as { text?: string }).text ?? ''
    expect(text).toContain('linked fine? — 1 options ·')
    expect(text).toContain('parked link? — 0 options (!) · ')
    expect(text).toContain('dangling link? — 0 options (!) · ')
    void linked
  })

  it('renders an empty counter-evidence line in the irreversible confirmation block', async () => {
    const test = await harness()
    const bare = await test.ctx.decisions.create({
      question: 'Irreversible without a counter section?',
      reversibility: 'irreversible',
      options: [{ label: 'go', evidence: 'nothing opposes' }],
    })
    const first = await run(test, ` choose ${String(bare.id).slice(-8)} go`)
    expect(first.kind).toBe('error')
    expect(first.text).toContain('Counter-evidence: (none recorded)')
    const fresh = await test.ctx.decisions.get(bare.id)
    const confirmed = await run(test, ` choose ${String(bare.id).slice(-8)} go confirm ${fresh?.updatedAt}`)
    expect(confirmed.kind).toBe('success')
  })

  it('rejects bare id-verbs with targeted usage lines', async () => {
    const test = await harness()
    const choose = await run(test, ' choose')
    expect(choose.kind).toBe('error')
    expect(choose.text).toContain('/decide choose requires a decision id and an option.')
    const show = await run(test, ' show')
    expect(show.text).toContain('/decide show requires a decision id.')
    const rev = await run(test, ' rev')
    expect(rev.text).toContain('/decide rev requires a decision id and an outcome.')

    // With an id but no payload, the second-stage usage line fires.
    await run(test, ' partial')
    const hint = firstHint(test)
    const labelless = await run(test, ` choose ${hint}`)
    expect(labelless.text).toContain('requires a decision id and an option label.')
    const outcomeless = await run(test, ` rev ${hint}`)
    expect(outcomeless.text).toContain('requires a decision id and a one-line outcome.')

    // Every id verb reports an absent fragment the same way, review included.
    for (const verb of ['show', 'choose', 'super', 'delete', 'rev']) {
      const absent = await run(test, ` ${verb} ffffffff${verb === 'choose' ? ' x' : verb === 'rev' ? ' x' : ''}`)
      expect(absent.kind).toBe('error')
      expect(absent.text).toContain('No decision id matches')
    }
  })

  it('renders a recommendation without confidence and a review against a frozen prediction', async () => {
    const test = await harness()
    const decision = await test.ctx.decisions.create({
      question: 'Hedge the deploy?',
      options: [{ label: 'yes', evidence: 'flaky upstream' }, { label: 'no', evidence: 'stable weeks' }],
    })
    await test.ctx.decisions.update(decision.id, { recommendation: 'yes', rationale: 'cheap insurance' })
    const hint = String(decision.id).slice(-8)
    const card = await run(test, ` show ${hint}`)
    expect(card.text).toContain('Recommendation: yes')
    expect(card.text).not.toContain('confidence')
    const chosen = await run(test, ` choose ${hint} yes`)
    expect(chosen.text).toContain('Chosen: yes')
    expect(chosen.text).not.toContain('frozen at')
    const review = await run(test, ` rev ${hint} hedge unused, deploy clean`)
    expect(review.text).toContain('Prediction: no frozen prediction')

    // A drafted confidence is what a later review reports as the prediction.
    const second = await test.ctx.decisions.create({
      question: 'Adopt the fork?',
      options: [{ label: 'adopt', evidence: 'upstream stalled' }],
    })
    await test.ctx.decisions.update(second.id, { confidence: 0.8 })
    await test.ctx.decisions.decide(second.id, 'adopt')
    const secondHint = String(second.id).slice(-8)
    const frozen = await run(test, ` rev ${secondHint} fork merged, maintenance lighter`)
    expect(frozen.text).toContain('Prediction: predicted 0.8')
  })

  it('rethrows foreign errors from the domain untouched', async () => {
    const test = await harness()
    await run(test, ' resilient')
    const foreign = vi.spyOn(test.ctx.decisions, 'supersede')
      .mockRejectedValue(new Error('medium offline'))
    await expect(run(test, ` super ${firstHint(test)}`)).rejects.toThrow('medium offline')
    foreign.mockRestore()
  })
})
