import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import DecisionRegistry, { DecisionId, decisionDomainSpec } from '../src/index.ts'
import { ObjectiveId } from '@deepseek-ai/dsh-objective'
import type { DecisionChanged, DecisionRecord } from '../src/index.ts'

/** Boot the real storage/domain/registry composition over an in-memory medium. */
async function harness(options: { pool?: MemoryMediaPool; backend?: StorageBackend } = {}) {
  const ctx = new Context()
  const pool = options.pool ?? new MemoryMediaPool()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', options.backend ?? new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const changes: DecisionChanged[] = []
  ctx.on('decision/changed', (change) => { changes.push(change) })
  const fiber = await ctx.plugin(DecisionRegistry)
  return { ctx, fiber, pool, facility, registry: ctx.decisions, changes }
}


/** One injected medium failure: fail `op` on its `at`-th invocation. */
interface InjectedFailure {
  op: 'putRecord' | 'deleteRecord' | 'setGlobal'
  at: number
}

/** Wrap a backend so named unit operations fail on chosen invocations. */
function flakyBackend(inner: StorageBackend, failures: readonly InjectedFailure[]): StorageBackend {
  const counts = new Map<string, number>()
  return {
    kv: {
      open: async (descriptor: never) => {
        const unit = await (inner.kv as unknown as { open(d: never): Promise<Record<string, unknown>> }).open(descriptor)
        const wrap = (op: string, original: (...args: unknown[]) => Promise<unknown>) =>
          async (...args: unknown[]): Promise<unknown> => {
            const nth = (counts.get(op) ?? 0) + 1
            counts.set(op, nth)
            if (failures.some(failure => failure.op === op && failure.at === nth)) {
              throw new Error(`injected ${op} failure`)
            }
            return await original.apply(unit, args)
          }
        const wrapped = Object.create(unit) as Record<string, unknown>
        wrapped.putRecord = wrap('putRecord', unit.putRecord as (...args: unknown[]) => Promise<unknown>)
        wrapped.deleteRecord = wrap('deleteRecord', unit.deleteRecord as (...args: unknown[]) => Promise<unknown>)
        wrapped.setGlobal = wrap('setGlobal', unit.setGlobal as (...args: unknown[]) => Promise<unknown>)
        return wrapped
      },
    },
    close: () => inner.close(),
  } as unknown as StorageBackend
}

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  question: 'orphan',
  options: [],
  counterEvidence: '',
  reversibility: 'reversible',
  status: 'open',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  ...over,
})

describe('decision registry', () => {
  it('creates open decisions prepended to the durable order', async () => {
    const { registry } = await harness()
    const first = await registry.create({ question: '  Rewrite or repair rulelift?  ' })
    const second = await registry.create({
      question: 'Fund the P0 fix?',
      reversibility: 'costly',
      options: [{ label: 'yes', evidence: 'six audits agree', cost: 'two weeks' }],
    })
    expect(first.status).toBe('open')
    expect(first.question).toBe('Rewrite or repair rulelift?')
    expect(first.reversibility).toBe('reversible')
    expect(first.counterEvidence).toBe('')
    expect(second.options).toEqual([
      { label: 'yes', evidence: 'six audits agree', cost: 'two weeks' },
    ])
    expect(registry.list().map(decision => decision.question)).toEqual(
      ['Fund the P0 fix?', 'Rewrite or repair rulelift?'],
    )
    expect(registry.listOpen()).toHaveLength(2)
  })

  it('rejects blank questions, duplicate labels, bad confidence, and unknown reversibility', async () => {
    const { registry } = await harness()
    await expect(registry.create({ question: ' ' })).rejects.toMatchObject({ code: 'DECISION_INVALID_QUESTION' })
    await expect(registry.create({
      question: 'q',
      options: [
        { label: 'a', evidence: '' },
        { label: ' a ', evidence: '' },
      ],
    })).rejects.toMatchObject({ code: 'DECISION_INVALID_OPTION' })
    await expect(registry.create({ question: 'q', options: [{ label: 'a' }] as never }))
      .rejects.toMatchObject({ code: 'DECISION_INVALID_OPTION' })
    await expect(registry.update(DecisionId('decision-x'), { confidence: 1.5 })).rejects.toBeTruthy()
  })

  it('updates draft fields on open decisions only, including clears', async () => {
    const { registry } = await harness()
    const decision = await registry.create({ question: 'q' })
    const drafted = await registry.update(decision.id, {
      options: [{ label: 'repair', evidence: 'cheap' }, { label: 'rewrite', evidence: 'clean' }],
      recommendation: 'repair',
      rationale: 'lowest cost now',
      confidence: 0.7,
      counterEvidence: 'rewrite removes the whole class of bugs; repair does not',
    })
    expect(drafted.recommendation).toBe('repair')
    expect(drafted.counterEvidence).toContain('rewrite removes')
    const cleared = await registry.update(decision.id, { recommendation: null, confidence: null })
    expect(cleared.recommendation).toBeUndefined()
    expect(cleared.confidence).toBeUndefined()
    expect(cleared.options).toHaveLength(2)
    await expect(registry.update(decision.id, {})).rejects.toMatchObject({ code: 'DECISION_INVALID_UPDATE' })
    await expect(registry.update(DecisionId('decision-void'), { question: 'x' }))
      .rejects.toMatchObject({ code: 'DECISION_NOT_FOUND' })
  })

  it('decides with a card-validated option and freezes the confidence snapshot', async () => {
    const { registry } = await harness()
    const decision = await registry.create({
      question: 'q',
      options: [{ label: 'repair', evidence: 'x' }, { label: 'rewrite', evidence: 'y' }],
    })
    await registry.update(decision.id, { recommendation: 'repair', confidence: 0.6 })
    await expect(registry.decide(decision.id, 'nope')).rejects.toMatchObject({ code: 'DECISION_UNKNOWN_OPTION' })
    const decided = await registry.decide(decision.id, 'repair', { confidence: 0.75 })
    expect(decided.status).toBe('decided')
    expect(decided.chosen).toBe('repair')
    expect(decided.predictedConfidence).toBe(0.75)
    expect(decided.decidedAt).toBe(decided.updatedAt)
    // A decided decision is history: draft updates and re-deciding reject.
    await expect(registry.update(decision.id, { question: 'later' }))
      .rejects.toMatchObject({ code: 'DECISION_INVALID_TRANSITION' })
    await expect(registry.decide(decision.id, 'repair'))
      .rejects.toMatchObject({ code: 'DECISION_INVALID_TRANSITION' })
    expect(registry.listOpen()).toEqual([])
  })

  it('records reviews against the frozen prediction and keeps them past deletion', async () => {
    const { registry } = await harness()
    const decision = await registry.create({ question: 'q', options: [{ label: 'a', evidence: 'x' }] })
    await registry.update(decision.id, { confidence: 0.8 })
    await registry.decide(decision.id, 'a')
    await expect(registry.recordReview(decision.id, ' ')).rejects.toMatchObject({ code: 'DECISION_INVALID_OUTCOME' })
    const review = await registry.recordReview(decision.id, 'As expected: P0s closed, no regressions', {
      calibrationNote: 'estimate held',
    })
    expect(review.predictedConfidence).toBe(0.8)
    expect(review.actualOutcome).toContain('no regressions')
    // A second review is allowed; the trail keeps both, oldest first.
    const again = await registry.recordReview(decision.id, 'Still holding a month later')
    const trail = registry.reviewsOf(decision.id)
    expect(trail.map(item => item.actualOutcome)).toEqual([
      'As expected: P0s closed, no regressions',
      'Still holding a month later',
    ])
    expect(trail.every(item => item.predictedConfidence === 0.8)).toBe(true)
    // Reviews of an open decision reject.
    const open = await registry.create({ question: 'still open' })
    await expect(registry.recordReview(open.id, 'x')).rejects.toMatchObject({ code: 'DECISION_INVALID_TRANSITION' })
    // Deletion keeps the calibration trail.
    await registry.delete(decision.id)
    expect(registry.get(decision.id)).toBeUndefined()
    expect(registry.reviewsOf(decision.id)).toHaveLength(2)
    expect(again.actualOutcome).toContain('Still holding')
  })

  it('supersedes idempotently and keeps the trail readable', async () => {
    const { registry } = await harness()
    const decision = await registry.create({ question: 'q' })
    const superseded = await registry.supersede(decision.id)
    expect(superseded.status).toBe('superseded')
    const again = await registry.supersede(decision.id)
    expect(again.updatedAt).toBe(superseded.updatedAt)
    expect(registry.listOpen()).toEqual([])
  })

  it('emits decision/changed after each durable mutation', async () => {
    const { ctx, registry, changes } = await harness()
    const decision = await registry.create({ question: 'q' })
    await registry.update(decision.id, { confidence: 0.5 })
    await registry.decide(decision.id, 'x')
    await registry.recordReview(decision.id, 'fine')
    await registry.delete(decision.id)
    expect(changes.map(change => change.operation)).toEqual(['create', 'update', 'decide', 'review', 'delete'])
    expect(changes.at(-1)?.decision).toBeUndefined()
    expect(() => { ctx.emit('decision/changed', { operation: 'delete' }) }).not.toThrow()
  })

  it('restores from a previous medium and fails loud on divergence', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ pool })
    const decision = await first.registry.create({ question: 'durable' })
    await first.fiber.dispose()
    const second = await harness({ pool })
    expect(second.registry.get(decision.id)?.question).toBe('durable')

    const orphanCtx = new Context()
    await orphanCtx.plugin(Storage)
    orphanCtx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(orphanCtx, { backend: 'memory', routes: {} })
    orphanCtx.storage.mount('domain', facility)
    orphanCtx.provide('storageDomain', facility)
    const domain = await facility.open(decisionDomainSpec)
    await domain.table('decisions').put(DecisionId('decision-orphan'), record())
    await domain.close()
    await expect(orphanCtx.plugin(DecisionRegistry)).rejects.toThrow(/absent from registry order/)
  })

  it('rejects mutations before the registry has started', async () => {
    const ctx = new Context()
    const registry = new DecisionRegistry(ctx)
    await expect(registry.create({ question: 'early' })).rejects.toThrow('not started yet')
    expect(() => registry.list()).toThrow('not started yet')
  })

  it('covers the full draft-update surface: question, triage, due date, rationale clears', async () => {
    const { registry } = await harness()
    const decision = await registry.create({
      question: 'q',
      objectiveId: ObjectiveId('objective-1'),
      dueAt: '2026-09-01T00:00:00.000Z',
      options: [{ label: 'a', evidence: 'x', risk: 'one week of flaky tests' }],
    })
    expect(decision.objectiveId).toBe(ObjectiveId('objective-1'))
    expect(decision.dueAt).toBe('2026-09-01T00:00:00.000Z')
    expect(decision.options[0]?.risk).toBe('one week of flaky tests')
    const updated = await registry.update(decision.id, {
      question: 'q2',
      rationale: 'first pass',
      reversibility: 'irreversible',
      dueAt: '2026-10-01T00:00:00.000Z',
    })
    expect(updated.question).toBe('q2')
    expect(updated.rationale).toBe('first pass')
    expect(updated.reversibility).toBe('irreversible')
    expect(updated.dueAt).toBe('2026-10-01T00:00:00.000Z')
    const cleared = await registry.update(decision.id, { rationale: null, dueAt: null })
    expect(cleared.rationale).toBeUndefined()
    expect(cleared.dueAt).toBeUndefined()
    await expect(registry.update(decision.id, { confidence: Number.NaN }))
      .rejects.toMatchObject({ code: 'DECISION_INVALID_CONFIDENCE' })
    await expect(registry.create({ question: 'q', reversibility: 'nope' as never }))
      .rejects.toMatchObject({ code: 'DECISION_INVALID_REVERSIBILITY' })
    await expect(registry.decide(decision.id, '  ')).rejects.toMatchObject({ code: 'DECISION_UNKNOWN_OPTION' })
  })

  it('decides without any recorded confidence and reviews that trail', async () => {
    const { registry } = await harness()
    const decision = await registry.create({ question: 'q', options: [{ label: 'a', evidence: 'x' }] })
    const decided = await registry.decide(decision.id, 'a')
    expect(decided.predictedConfidence).toBeUndefined()
    const review = await registry.recordReview(decision.id, 'done')
    expect(review.predictedConfidence).toBeUndefined()
    expect(registry.reviewsOf(decision.id)).toEqual([review])
  })

  it('keeps each decision reviews scoped and deletes idempotently', async () => {
    const { registry } = await harness()
    const a = await registry.create({ question: 'a', options: [{ label: 'x', evidence: 'e' }] })
    const b = await registry.create({ question: 'b', options: [{ label: 'y', evidence: 'e' }] })
    await registry.decide(a.id, 'x')
    await registry.decide(b.id, 'y')
    await registry.recordReview(a.id, 'a outcome')
    await registry.recordReview(b.id, 'b outcome')
    expect(registry.reviewsOf(a.id).map(review => review.actualOutcome)).toEqual(['a outcome'])
    await expect(registry.delete(DecisionId('decision-void'))).resolves.toBe(false)
    await expect(registry.delete(a.id)).resolves.toBe(true)
  })

  it('reports both failures when a create rollback also fails', async () => {
    const pool = new MemoryMediaPool()
    const { registry } = await harness({
      pool,
      backend: flakyBackend(new MemoryStorageBackend(pool), [
        { op: 'setGlobal', at: 1 },
        { op: 'deleteRecord', at: 1 },
      ]),
    })
    await expect(registry.create({ question: 'doomed twice' })).rejects.toThrow(AggregateError)
    await expect(harness({ pool })).rejects.toThrow(/absent from registry order/)
  })

  it('restores the registry order when a delete record write fails', async () => {
    const pool = new MemoryMediaPool()
    const { registry } = await harness({
      pool,
      backend: flakyBackend(new MemoryStorageBackend(pool), [{ op: 'deleteRecord', at: 1 }]),
    })
    const decision = await registry.create({ question: 'delete rollback' })
    await expect(registry.delete(decision.id)).rejects.toThrow('injected deleteRecord failure')
    expect(registry.get(decision.id)?.question).toBe('delete rollback')

    const doomed = new MemoryMediaPool()
    const both = await harness({
      pool: doomed,
      backend: flakyBackend(new MemoryStorageBackend(doomed), [
        { op: 'deleteRecord', at: 1 },
        { op: 'setGlobal', at: 3 },
      ]),
    })
    const stuck = await both.registry.create({ question: 'stuck delete' })
    await expect(both.registry.delete(stuck.id)).rejects.toThrow(AggregateError)
  })

  it('aggregates the calibration trail by objective across deleted decisions', async () => {
    const { registry } = await harness()
    const objective = ObjectiveId('objective-cal')
    const other = ObjectiveId('objective-other')
    const a = await registry.create({
      question: 'a',
      objectiveId: objective,
      options: [{ label: 'x', evidence: 'e' }],
    })
    const b = await registry.create({
      question: 'b',
      objectiveId: objective,
      options: [{ label: 'y', evidence: 'e' }],
    })
    const c = await registry.create({
      question: 'c',
      objectiveId: other,
      options: [{ label: 'z', evidence: 'e' }],
    })
    await registry.update(a.id, { confidence: 0.8 })
    await registry.decide(a.id, 'x')
    await registry.decide(b.id, 'y')
    await registry.decide(c.id, 'z')
    await registry.recordReview(a.id, 'held up', { calibrationNote: 'estimate was fair' })
    await registry.recordReview(b.id, 'slipped a week')
    await registry.recordReview(c.id, 'unrelated topic')
    // The trail aggregates under the objective, oldest first, both decisions.
    expect(registry.reviewsByObjective(objective).map(review => review.actualOutcome))
      .toEqual(['held up', 'slipped a week'])
    expect(registry.reviewsByObjective(objective).every(review => review.objectiveId === objective)).toBe(true)
    expect(registry.reviewsByObjective(objective)[0]?.calibrationNote).toBe('estimate was fair')
    expect(registry.reviewsByObjective(other).map(review => review.actualOutcome)).toEqual(['unrelated topic'])
    // Deleting a decision keeps its reviews in the objective aggregate.
    await registry.delete(a.id)
    expect(registry.reviewsByObjective(objective).map(review => review.actualOutcome))
      .toEqual(['held up', 'slipped a week'])
    // An unlinked decision's reviews never match an objective aggregate.
    const unlinked = await registry.create({ question: 'u', options: [{ label: 'l', evidence: 'e' }] })
    await registry.decide(unlinked.id, 'l')
    await registry.recordReview(unlinked.id, 'free-floating')
    expect(registry.reviewsByObjective(objective).map(review => review.actualOutcome))
      .toEqual(['held up', 'slipped a week'])
  })

  it('rejects an irreversible decide without confirmation and honors the card stamp', async () => {
    const { registry } = await harness()
    const decision = await registry.create({
      question: 'Burn the bridge?',
      reversibility: 'irreversible',
      options: [{ label: 'burn', evidence: 'crossing is done' }],
    })
    await expect(registry.decide(decision.id, 'burn')).rejects.toMatchObject({ code: 'DECISION_IRREVERSIBLE_CONFIRM' })
    // The stamp fence fires before the confirmation gate order does not matter;
    // both rejections leave the decision open.
    await expect(registry.decide(decision.id, 'burn', { confirm: true, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'DECISION_STALE_CARD' })
    expect(registry.get(decision.id)?.status).toBe('open')
    const stamped = await registry.decide(decision.id, 'burn', { confirm: true, expectedUpdatedAt: decision.updatedAt })
    expect(stamped.status).toBe('decided')
    // A reversible decision never asks for confirmation.
    const easy = await registry.create({ question: 'Try the flag?', options: [{ label: 'on', evidence: 'flip it' }] })
    await expect(registry.decide(easy.id, 'on')).resolves.toMatchObject({ status: 'decided' })
  })

  it('fails loud at startup on repeated and ghost registry order entries', async () => {
    const repeatCtx = new Context()
    await repeatCtx.plugin(Storage)
    repeatCtx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(repeatCtx, { backend: 'memory', routes: {} })
    repeatCtx.storage.mount('domain', facility)
    repeatCtx.provide('storageDomain', facility)
    const domain = await facility.open(decisionDomainSpec)
    const repeated = DecisionId('decision-twice')
    await domain.table('decisions').put(repeated, record({ question: 'twice' }))
    await domain.global.set({ decisionIds: [repeated, repeated] })
    await domain.close()
    await expect(repeatCtx.plugin(DecisionRegistry)).rejects.toThrow(/repeats decision/)

    const ghostCtx = new Context()
    await ghostCtx.plugin(Storage)
    ghostCtx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const ghostFacility = new DomainFacility(ghostCtx, { backend: 'memory', routes: {} })
    ghostCtx.storage.mount('domain', ghostFacility)
    ghostCtx.provide('storageDomain', ghostFacility)
    const ghostDomain = await ghostFacility.open(decisionDomainSpec)
    await ghostDomain.global.set({ decisionIds: [DecisionId('decision-ghost')] })
    await ghostDomain.close()
    await expect(ghostCtx.plugin(DecisionRegistry)).rejects.toThrow(/references missing decision/)
  })

  it('round-trips an objective-linked decision through the medium', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ pool })
    const linked = await first.registry.create({
      question: 'linked',
      objectiveId: ObjectiveId('objective-linked'),
      options: [{ label: 'go', evidence: 'brief says so', cost: '3 days', risk: 'regression window' }],
    })
    await first.fiber.dispose()
    const second = await harness({ pool })
    const restored = second.registry.get(linked.id)
    expect(restored?.objectiveId).toBe(ObjectiveId('objective-linked'))
    expect(restored?.options).toEqual([{ label: 'go', evidence: 'brief says so', cost: '3 days', risk: 'regression window' }])
  })

  it('rolls a create back when the order write fails and stays usable', async () => {
    const pool = new MemoryMediaPool()
    const { registry } = await harness({
      pool,
      backend: flakyBackend(new MemoryStorageBackend(pool), [{ op: 'setGlobal', at: 1 }]),
    })
    await expect(registry.create({ question: 'doomed' })).rejects.toThrow('injected setGlobal failure')
    expect(registry.list()).toEqual([])
    const survivor = await registry.create({ question: 'after rollback' })
    expect(registry.get(survivor.id)?.question).toBe('after rollback')
  })
})
