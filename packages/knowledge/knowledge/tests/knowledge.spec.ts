import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ClaimRegistry, { ClaimError, ClaimId, claimDomainSpec, canonicalDocumentUri } from '../src/index.ts'
import type { ClaimChanged, ClaimRecord } from '../src/index.ts'
import { ObjectiveId } from '@deepseek-ai/dsh-objective'

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

/** Boot the real storage/domain/registry composition over an in-memory medium. */
async function harness(options: { pool?: MemoryMediaPool; backend?: StorageBackend } = {}) {
  const ctx = new Context()
  const pool = options.pool ?? new MemoryMediaPool()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', options.backend ?? new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const changes: ClaimChanged[] = []
  ctx.on('claim/changed', (change) => { changes.push(change) })
  const fiber = await ctx.plugin(ClaimRegistry)
  return { ctx, fiber, pool, registry: ctx.claims, changes }
}

const record = (over: Partial<ClaimRecord> = {}): ClaimRecord => ({
  proposition: 'orphan',
  sourceKind: 'session',
  sourceUri: 'session://x#L1',
  status: 'active',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  ...over,
})

describe('knowledge registry', () => {
  it('reduces source locations to canonical document roots', () => {
    expect(canonicalDocumentUri('file://audit.md#L120')).toBe('file://audit.md')
    expect(canonicalDocumentUri('file://audit.md#section-two')).toBe('file://audit.md')
    expect(canonicalDocumentUri('session://abc:L42')).toBe('session://abc')
    expect(canonicalDocumentUri('https://example.com/doc')).toBe('https://example.com/doc')
  })

  it('creates active claims with mandatory provenance, newest first', async () => {
    const { registry } = await harness()
    const first = await registry.create({
      proposition: '  chi2 binning collapses under extreme proportions  ',
      sourceKind: 'session',
      sourceUri: 'session://audit-3#L120',
      sourceSession: 'session-3',
      sourceAnchor: '120',
      confidence: 0.9,
      validUntil: '2026-12-01T00:00:00.000Z',
      objectiveId: ObjectiveId('objective-rulelift'),
    })
    expect(first.status).toBe('active')
    expect(first.proposition).toBe('chi2 binning collapses under extreme proportions')
    expect(first.sourceUri).toBe('session://audit-3#L120')
    expect(first.objectiveId).toBe(ObjectiveId('objective-rulelift'))
    const second = await registry.create({
      proposition: 'v2.8.1 fixed the collapse',
      sourceKind: 'memory',
      sourceUri: 'memory://MEMORY.md#chi2',
    })
    expect(registry.list().map(claim => claim.proposition)).toEqual(
      ['v2.8.1 fixed the collapse', 'chi2 binning collapses under extreme proportions'],
    )
    expect(registry.listActive()).toHaveLength(2)
    void second
  })

  it('rejects blank propositions, unknown kinds, empty uris, and out-of-range confidence', async () => {
    const { registry } = await harness()
    await expect(registry.create({ proposition: ' ', sourceKind: 'session', sourceUri: 'x' }))
      .rejects.toMatchObject({ code: 'CLAIM_INVALID_PROPOSITION' })
    await expect(registry.create({ proposition: 'p', sourceKind: 'nope' as never, sourceUri: 'x' }))
      .rejects.toMatchObject({ code: 'CLAIM_INVALID_SOURCE' })
    await expect(registry.create({ proposition: 'p', sourceKind: 'session', sourceUri: ' ' }))
      .rejects.toMatchObject({ code: 'CLAIM_INVALID_SOURCE' })
    await expect(registry.create({ proposition: 'p', sourceKind: 'session', sourceUri: 'x', confidence: 1.5 }))
      .rejects.toMatchObject({ code: 'CLAIM_INVALID_CONFIDENCE' })
  })

  it('links claim pairs, replaces a pair relation, and rejects self and unknown ends', async () => {
    const { registry } = await harness()
    const a = await registry.create({ proposition: 'a', sourceKind: 'session', sourceUri: 's://a' })
    const b = await registry.create({ proposition: 'b', sourceKind: 'session', sourceUri: 's://b' })
    await expect(registry.link(a.id, a.id, 'supports')).rejects.toMatchObject({ code: 'CLAIM_SELF_EDGE' })
    await expect(registry.link(a.id, ClaimId('claim-void'), 'supports')).rejects.toMatchObject({ code: 'CLAIM_NOT_FOUND' })
    await expect(registry.link(a.id, b.id, 'nope' as never)).rejects.toBeTruthy()
    await registry.link(a.id, b.id, 'supersedes')
    expect(registry.edgesOf(a.id)).toEqual([{ src: a.id, dst: b.id, relation: 'supersedes' }])
    // Incoming edges surface from the other end.
    expect(registry.edgesOf(b.id)).toEqual([{ src: a.id, dst: b.id, relation: 'supersedes' }])
    // Re-linking the same pair replaces the relation.
    await registry.link(a.id, b.id, 'refines')
    expect(registry.edgesOf(a.id)[0]?.relation).toBe('refines')

    // An edge between two other claims never surfaces.
    const c = await registry.create({ proposition: 'c', sourceKind: 'session', sourceUri: 's://c' })
    const d = await registry.create({ proposition: 'd', sourceKind: 'session', sourceUri: 's://d' })
    await registry.link(c.id, d.id, 'supports')
    expect(registry.edgesOf(a.id)).toHaveLength(1)
    expect(registry.edgesOf(d.id)).toEqual([{ src: c.id, dst: d.id, relation: 'supports' }])
  })

  it('promotes only with two distinct document roots and treats fragments as one source', async () => {
    const { registry } = await harness()
    const claim = await registry.create({
      proposition: 'collapse fixed in v2.8.1',
      sourceKind: 'memory',
      sourceUri: 'memory://MEMORY.md#chi2',
    })
    // Same document, different anchors: still one source.
    await expect(registry.promote(claim.id, ['memory://MEMORY.md#other-anchor']))
      .rejects.toMatchObject({ code: 'CLAIM_INVALID_CORROBORATION' })
    await expect(registry.promote(claim.id, ['not-a-uri', 42 as never]))
      .rejects.toMatchObject({ code: 'CLAIM_INVALID_CORROBORATION' })
    // A line anchor on the same document root is still one source.
    await expect(registry.promote(claim.id, ['memory://MEMORY.md:L99']))
      .rejects.toMatchObject({ code: 'CLAIM_INVALID_CORROBORATION' })
    const promoted = await registry.promote(claim.id, ['session://audit-4#L8'])
    expect(promoted.status).toBe('promoted')
    expect(registry.listActive()).toEqual([])
    // Promoted is immutable; retire demotes.
    await expect(registry.promote(claim.id, ['session://audit-5#L1']))
      .rejects.toMatchObject({ code: 'CLAIM_PROMOTED_IMMUTABLE' })
    const retired = await registry.retire(claim.id)
    expect(retired.status).toBe('retired')
    // A retired claim does not promote.
    await expect(registry.promote(claim.id, ['session://audit-5#L1']))
      .rejects.toMatchObject({ code: 'CLAIM_INVALID_PROMOTION' })
  })

  it('retires idempotently and deletes while edges stay behind', async () => {
    const { registry } = await harness()
    const a = await registry.create({ proposition: 'a', sourceKind: 'session', sourceUri: 's://a' })
    const b = await registry.create({ proposition: 'b', sourceKind: 'session', sourceUri: 's://b' })
    await registry.link(a.id, b.id, 'contradicts')
    const retired = await registry.retire(a.id)
    const again = await registry.retire(a.id)
    expect(again.updatedAt).toBe(retired.updatedAt)
    await expect(registry.delete(a.id)).resolves.toBe(true)
    await expect(registry.delete(a.id)).resolves.toBe(false)
    expect(registry.get(a.id)).toBeUndefined()
    // The edge naming the deleted claim is inert data, still readable.
    expect(registry.edgesOf(b.id)).toEqual([{ src: a.id, dst: b.id, relation: 'contradicts' }])
  })

  it('emits claim/changed after each durable mutation', async () => {
    const { ctx, registry, changes } = await harness()
    const claim = await registry.create({ proposition: 'p', sourceKind: 'session', sourceUri: 's://p' })
    const other = await registry.create({ proposition: 'q', sourceKind: 'session', sourceUri: 's://q' })
    await registry.link(claim.id, other.id, 'supports')
    await registry.promote(claim.id, ['s://other'])
    await registry.retire(claim.id)
    await registry.delete(claim.id)
    expect(changes.map(change => change.operation)).toEqual(['create', 'create', 'link', 'promote', 'retire', 'delete'])
    expect(changes.at(-1)?.claim).toBeUndefined()
    expect(() => { ctx.emit('claim/changed', { operation: 'delete' }) }).not.toThrow()
  })

  it('restores from a previous medium and fails loud on divergence', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ pool })
    const claim = await first.registry.create({
      proposition: 'durable',
      sourceKind: 'session',
      sourceUri: 's://d',
      objectiveId: ObjectiveId('objective-linked'),
    })
    await first.fiber.dispose()
    const second = await harness({ pool })
    const restored = second.registry.get(claim.id)
    expect(restored?.proposition).toBe('durable')
    expect(restored?.objectiveId).toBe(ObjectiveId('objective-linked'))

    const orphanCtx = new Context()
    await orphanCtx.plugin(Storage)
    orphanCtx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(orphanCtx, { backend: 'memory', routes: {} })
    orphanCtx.storage.mount('domain', facility)
    orphanCtx.provide('storageDomain', facility)
    const domain = await facility.open(claimDomainSpec)
    await domain.table('claims').put(ClaimId('claim-orphan'), record())
    await domain.close()
    await expect(orphanCtx.plugin(ClaimRegistry)).rejects.toThrow(/absent from registry order/)

    const ghostCtx = new Context()
    await ghostCtx.plugin(Storage)
    ghostCtx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const ghostFacility = new DomainFacility(ghostCtx, { backend: 'memory', routes: {} })
    ghostCtx.storage.mount('domain', ghostFacility)
    ghostCtx.provide('storageDomain', ghostFacility)
    const ghostDomain = await ghostFacility.open(claimDomainSpec)
    await ghostDomain.global.set({ claimIds: [ClaimId('claim-ghost')] })
    await ghostDomain.close()
    await expect(ghostCtx.plugin(ClaimRegistry)).rejects.toThrow(/references missing claim/)

    const repeatCtx = new Context()
    await repeatCtx.plugin(Storage)
    repeatCtx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const repeatFacility = new DomainFacility(repeatCtx, { backend: 'memory', routes: {} })
    repeatCtx.storage.mount('domain', repeatFacility)
    repeatCtx.provide('storageDomain', repeatFacility)
    const repeatDomain = await repeatFacility.open(claimDomainSpec)
    const repeated = ClaimId('claim-twice')
    await repeatDomain.table('claims').put(repeated, record())
    await repeatDomain.global.set({ claimIds: [repeated, repeated] })
    await repeatDomain.close()
    await expect(repeatCtx.plugin(ClaimRegistry)).rejects.toThrow(/repeats claim/)
  })

  it('rejects mutations before the registry has started', async () => {
    const ctx = new Context()
    const registry = new ClaimRegistry(ctx)
    await expect(registry.create({ proposition: 'early', sourceKind: 'session', sourceUri: 'x' }))
      .rejects.toThrow('not started yet')
    expect(() => registry.list()).toThrow('not started yet')
  })

  it('rolls a create back when the order write fails and survives it', async () => {
    const pool = new MemoryMediaPool()
    const { registry } = await harness({
      pool,
      backend: flakyBackend(new MemoryStorageBackend(pool), [{ op: 'setGlobal', at: 1 }]),
    })
    await expect(registry.create({ proposition: 'doomed', sourceKind: 'session', sourceUri: 'x' }))
      .rejects.toThrow('injected setGlobal failure')
    expect(registry.list()).toEqual([])
    const survivor = await registry.create({ proposition: 'after rollback', sourceKind: 'session', sourceUri: 'x' })
    expect(registry.get(survivor.id)?.proposition).toBe('after rollback')
  })

  it('restores the order when a delete record write fails, reporting double failures', async () => {
    const pool = new MemoryMediaPool()
    const { registry } = await harness({
      pool,
      backend: flakyBackend(new MemoryStorageBackend(pool), [{ op: 'deleteRecord', at: 1 }]),
    })
    const claim = await registry.create({ proposition: 'delete rollback', sourceKind: 'session', sourceUri: 'x' })
    await expect(registry.delete(claim.id)).rejects.toThrow('injected deleteRecord failure')
    expect(registry.get(claim.id)?.proposition).toBe('delete rollback')

    // A create whose rollback also fails leaves the orphan and reports both.
    const doomedTwice = new MemoryMediaPool()
    const twin = await harness({
      pool: doomedTwice,
      backend: flakyBackend(new MemoryStorageBackend(doomedTwice), [
        { op: 'setGlobal', at: 1 },
        { op: 'deleteRecord', at: 1 },
      ]),
    })
    await expect(twin.registry.create({ proposition: 'doomed twice', sourceKind: 'session', sourceUri: 'x' }))
      .rejects.toThrow(AggregateError)

    const doomed = new MemoryMediaPool()
    const both = await harness({
      pool: doomed,
      backend: flakyBackend(new MemoryStorageBackend(doomed), [
        { op: 'deleteRecord', at: 1 },
        { op: 'setGlobal', at: 3 },
      ]),
    })
    const stuck = await both.registry.create({ proposition: 'stuck', sourceKind: 'session', sourceUri: 'x' })
    await expect(both.registry.delete(stuck.id)).rejects.toThrow(AggregateError)
  })

  it('surfaces domain rejections through the shared error type', async () => {
    const { registry } = await harness()
    expect(registry.get(ClaimId('claim-void'))).toBeUndefined()
    await expect(registry.retire(ClaimId('claim-void'))).rejects.toBeInstanceOf(ClaimError)
  })
})
