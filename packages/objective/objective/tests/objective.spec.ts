import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ObjectiveRegistry, {
  foldObjectiveMembership,
  ObjectiveError,
  ObjectiveId,
  objectiveDomainSpec,
} from '../src/index.ts'
import type { ObjectiveChanged, ObjectiveRecord } from '../src/index.ts'

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
        // KvUnit methods live on the prototype; delegate and override the three
        // fallible writers.
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
async function harness(options: {
  pool?: MemoryMediaPool
  backend?: StorageBackend
  withSessions?: boolean
} = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', options.backend ?? new MemoryStorageBackend(options.pool ?? new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  if (options.withSessions !== false) {
    await ctx.plugin(SessionStore)
  }
  const changes: ObjectiveChanged[] = []
  ctx.on('objective/changed', (change) => { changes.push(change) })
  const fiber = await ctx.plugin(ObjectiveRegistry)
  return { ctx, fiber, pool: options.pool, registry: ctx.objectives, changes }
}

const record = (over: Partial<ObjectiveRecord> = {}): ObjectiveRecord => ({
  title: 'orphan',
  status: 'active',
  sessionIds: [],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  ...over,
})

describe('objective registry', () => {
  it('creates active objectives prepended to the durable order', async () => {
    const { registry } = await harness()
    const first = await registry.create({ title: 'stabilize rulelift' })
    const second = await registry.create({ title: 'ship harness v1', northStar: ' tagged release' })
    expect(first.status).toBe('active')
    expect(first.sessionIds).toEqual([])
    expect(second.northStar).toBe('tagged release')
    expect(registry.list().map(objective => objective.title)).toEqual(['ship harness v1', 'stabilize rulelift'])
  })

  it('rejects blank titles and north-star statements', async () => {
    const { registry } = await harness()
    await expect(registry.create({ title: '  ' })).rejects.toMatchObject({ code: 'OBJECTIVE_INVALID_TITLE' })
    await expect(registry.create({ title: 'ok', northStar: '' }))
      .rejects.toMatchObject({ code: 'OBJECTIVE_INVALID_NORTH_STAR' })
  })

  it('edits title, status, and north-star including clear', async () => {
    const { registry } = await harness()
    const objective = await registry.create({ title: 'audit follow-ups', northStar: 'no open P0s' })
    const parked = await registry.update(objective.id, { status: 'parked' })
    expect(parked.status).toBe('parked')
    const retitled = await registry.update(objective.id, { title: 'follow-ups' })
    expect(retitled.title).toBe('follow-ups')
    expect(retitled.northStar).toBe('no open P0s')
    const cleared = await registry.update(objective.id, { northStar: null })
    expect(cleared.northStar).toBeUndefined()
    const replaced = await registry.update(objective.id, { northStar: ' zero P0 regressions' })
    expect(replaced.northStar).toBe('zero P0 regressions')
    await expect(registry.update(objective.id, {})).rejects.toMatchObject({ code: 'OBJECTIVE_INVALID_UPDATE' })
    await expect(registry.update(objective.id, { status: 'done' as never }))
      .rejects.toMatchObject({ code: 'OBJECTIVE_INVALID_STATUS' })
    await expect(registry.update(ObjectiveId('objective-missing'), { title: 'x' }))
      .rejects.toMatchObject({ code: 'OBJECTIVE_NOT_FOUND' })
  })

  it('attaches live sessions to the domain account and mirrors the membership event', async () => {
    const { ctx, registry } = await harness()
    const session = ctx.sessions.create(SessionId('member-live'))
    const objective = await registry.create({ title: 'convergence layers' })
    const before = session.seq
    const attached = await registry.attachSession(objective.id, session.id)
    expect(attached.sessionIds).toEqual([session.id])
    const event = session.events[session.seq - 1]
    if (event === undefined) throw new Error('membership event missing')
    expect(event.type).toBe('objective/member')
    if (event.type === 'objective/member') {
      expect(event.data).toEqual({
        version: 1,
        objectiveId: objective.id,
        title: 'convergence layers',
        action: 'attach',
      })
    }
    // Idempotent: no new durable write, no new event.
    const again = await registry.attachSession(objective.id, session.id)
    expect(again.updatedAt).toBe(attached.updatedAt)
    expect(session.seq).toBe(before + 1)
  })

  it('attaches a session that is not live: the domain is the membership authority', async () => {
    const { registry } = await harness()
    const objective = await registry.create({ title: 'cold members' })
    const attached = await registry.attachSession(objective.id, SessionId('member-cold'))
    expect(attached.sessionIds).toEqual([SessionId('member-cold')])
  })

  it('detaches members idempotently and records the detach event', async () => {
    const { ctx, registry } = await harness()
    const session = ctx.sessions.create(SessionId('member-detach'))
    const objective = await registry.create({ title: 'rotation' })
    await registry.attachSession(objective.id, session.id)
    const detached = await registry.detachSession(objective.id, session.id)
    expect(detached.sessionIds).toEqual([])
    const last = session.events[session.seq - 1]
    if (last === undefined) throw new Error('detach event missing')
    expect(last.type).toBe('objective/member')
    if (last.type === 'objective/member') expect(last.data.action).toBe('detach')
    const again = await registry.detachSession(objective.id, session.id)
    expect(again.updatedAt).toBe(detached.updatedAt)
  })

  it('answers which objectives one session serves', async () => {
    const { ctx, registry } = await harness()
    const session = ctx.sessions.create(SessionId('member-both'))
    const a = await registry.create({ title: 'a' })
    const b = await registry.create({ title: 'b' })
    await registry.attachSession(a.id, session.id)
    await registry.attachSession(b.id, session.id)
    expect(registry.objectivesOf(session.id).map(objective => objective.title)).toEqual(['b', 'a'])
    await registry.detachSession(b.id, session.id)
    expect(registry.objectivesOf(session.id).map(objective => objective.title)).toEqual(['a'])
  })

  it('stores the brief with its stamp and rejects blank briefs', async () => {
    const { registry } = await harness()
    const objective = await registry.create({ title: 'briefs' })
    const briefed = await registry.setBrief(objective.id, ' Six audits converge on fixing P0s first.')
    expect(briefed.brief).toBe('Six audits converge on fixing P0s first.')
    expect(briefed.briefAt).toBe(briefed.updatedAt)
    await expect(registry.setBrief(objective.id, '  ')).rejects.toMatchObject({ code: 'OBJECTIVE_INVALID_BRIEF' })
  })

  it('deletes idempotently and keeps member session logs untouched', async () => {
    const { ctx, registry } = await harness()
    const session = ctx.sessions.create(SessionId('member-delete'))
    const objective = await registry.create({ title: 'retired' })
    await registry.attachSession(objective.id, session.id)
    const seq = session.seq
    await expect(registry.delete(objective.id)).resolves.toBe(true)
    await expect(registry.delete(objective.id)).resolves.toBe(false)
    expect(registry.get(objective.id)).toBeUndefined()
    expect(session.seq).toBe(seq)
    expect(foldObjectiveMembership(session.events)).toHaveLength(1)
  })

  it('emits objective/changed after each durable mutation with the post-mutation view', async () => {
    const { ctx, registry, changes } = await harness()
    const session = ctx.sessions.create(SessionId('member-events'))
    const objective = await registry.create({ title: 'observed' })
    await registry.attachSession(objective.id, session.id)
    await registry.update(objective.id, { status: 'parked' })
    await registry.setBrief(objective.id, 'one paragraph')
    await registry.delete(objective.id)
    expect(changes.map(change => change.operation)).toEqual(['create', 'attach', 'update', 'brief', 'delete'])
    expect(changes[0]?.objective?.title).toBe('observed')
    expect(changes[changes.length - 1]?.objective).toBeUndefined()
    expect(() => { ctx.emit('objective/changed', { operation: 'delete' }) }).not.toThrow()
  })

  it('rejects new membership on parked and closed objectives but keeps the idempotent path', async () => {
    const { ctx, registry } = await harness()
    const session = ctx.sessions.create(SessionId('member-parked'))
    const objective = await registry.create({ title: 'wip lever' })
    await registry.attachSession(objective.id, session.id)
    await registry.update(objective.id, { status: 'parked' })
    // Already-accounted member: the idempotent path still resolves.
    const again = await registry.attachSession(objective.id, session.id)
    expect(again.sessionIds).toEqual([session.id])
    // A new member on a parked objective is the WIP lever firing: rejected.
    const newcomer = ctx.sessions.create(SessionId('member-new'))
    await expect(registry.attachSession(objective.id, newcomer.id))
      .rejects.toMatchObject({ code: 'OBJECTIVE_NOT_ACTIVE' })
    await registry.update(objective.id, { status: 'closed' })
    await expect(registry.attachSession(objective.id, newcomer.id))
      .rejects.toMatchObject({ code: 'OBJECTIVE_NOT_ACTIVE' })
  })

  it('guards brief writes with a compare-and-set fence on the brief stamp', async () => {
    const { registry } = await harness()
    const objective = await registry.create({ title: 'brief cas' })
    // No brief yet: a null expectation matches.
    const first = await registry.setBrief(objective.id, 'first brief', null)
    // The recorded stamp fences a concurrent writer that read the null state.
    await expect(registry.setBrief(objective.id, 'stale writer', null))
      .rejects.toMatchObject({ code: 'OBJECTIVE_STALE_BRIEF' })
    // A wrong concrete stamp rejects the same way.
    await expect(registry.setBrief(objective.id, 'wrong stamp', '2000-01-01T00:00:00.000Z'))
      .rejects.toMatchObject({ code: 'OBJECTIVE_STALE_BRIEF' })
    // The exact stamp writes; omitting the fence writes unconditionally.
    const second = await registry.setBrief(objective.id, 'second brief', first.briefAt)
    expect(second.brief).toBe('second brief')
    const third = await registry.setBrief(objective.id, 'unconditional')
    expect(third.brief).toBe('unconditional')
  })

  it('folds membership per objective with the last action winning', async () => {
    const { ctx, registry } = await harness()
    const session = ctx.sessions.create(SessionId('member-fold'))
    const a = await registry.create({ title: 'a' })
    const b = await registry.create({ title: 'b' })
    await registry.attachSession(a.id, session.id)
    await registry.attachSession(b.id, session.id)
    await registry.detachSession(a.id, session.id)
    await registry.attachSession(a.id, session.id)
    const folded = foldObjectiveMembership(session.events)
    // Detach deletes the map entry, so the re-attached objective re-enters at the tail.
    expect(folded.map(meta => String(meta.objectiveId))).toEqual([String(b.id), String(a.id)])
    expect(folded.map(meta => meta.action)).toEqual(['attach', 'attach'])
    // Projection posture: a malformed payload in the log is skipped, not thrown.
    const malformed = {
      type: 'objective/member',
      seq: session.seq,
      time: 0,
      data: { version: 1, objectiveId: '', title: 'x', action: 'attach' },
    } as never as Parameters<typeof foldObjectiveMembership>[0][number]
    expect(foldObjectiveMembership([...session.events, malformed])).toHaveLength(2)
  })

  it('restores the registry from a previous medium and serializes concurrent writes', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness({ pool })
    await first.registry.create({ title: 'durable one' })
    await first.registry.create({ title: 'durable two' })
    await first.fiber.dispose()
    const second = await harness({ pool })
    expect(second.registry.list().map(objective => objective.title)).toEqual(['durable two', 'durable one'])
    const created = await Promise.all([
      second.registry.create({ title: 'c1' }),
      second.registry.create({ title: 'c2' }),
      second.registry.create({ title: 'c3' }),
    ])
    expect(new Set(second.registry.list().map(objective => objective.id)).size).toBe(5)
    expect(created.every(objective => second.registry.get(objective.id) !== undefined)).toBe(true)
  })

  it('fails loud at startup when the order and records diverge', async () => {
    const pool = new MemoryMediaPool()
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    const domain = await facility.open(objectiveDomainSpec)
    await domain.table('objectives').put(ObjectiveId('objective-orphan'), record())
    await domain.close()
    await expect(ctx.plugin(ObjectiveRegistry)).rejects.toThrow(/absent from registry order/)

    const ghostCtx = new Context()
    await ghostCtx.plugin(Storage)
    ghostCtx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const ghostFacility = new DomainFacility(ghostCtx, { backend: 'memory', routes: {} })
    ghostCtx.storage.mount('domain', ghostFacility)
    ghostCtx.provide('storageDomain', ghostFacility)
    const ghostDomain = await ghostFacility.open(objectiveDomainSpec)
    await ghostDomain.global.set({ objectiveIds: [ObjectiveId('objective-ghost')] })
    await ghostDomain.close()
    await expect(ghostCtx.plugin(ObjectiveRegistry)).rejects.toThrow(/references missing objective/)

    const repeatCtx = new Context()
    await repeatCtx.plugin(Storage)
    repeatCtx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const repeatFacility = new DomainFacility(repeatCtx, { backend: 'memory', routes: {} })
    repeatCtx.storage.mount('domain', repeatFacility)
    repeatCtx.provide('storageDomain', repeatFacility)
    const repeatDomain = await repeatFacility.open(objectiveDomainSpec)
    const repeated = ObjectiveId('objective-twice')
    await repeatDomain.table('objectives').put(repeated, record())
    await repeatDomain.global.set({ objectiveIds: [repeated, repeated] })
    await repeatDomain.close()
    await expect(repeatCtx.plugin(ObjectiveRegistry)).rejects.toThrow(/repeats objective/)
  })

  it('rejects unknown sessions on nothing and stays usable after errors', async () => {
    const { registry } = await harness()
    const objective = await registry.create({ title: 'resilient' })
    const invalid = async () => registry.attachSession(ObjectiveId('objective-void'), SessionId('s'))
    await expect(invalid()).rejects.toBeInstanceOf(ObjectiveError)
    const attached = await registry.attachSession(objective.id, SessionId('after-error'))
    expect(attached.sessionIds).toEqual([SessionId('after-error')])
  })

  it('rolls a create back when the order write fails and stays usable', async () => {
    const pool = new MemoryMediaPool()
    const { registry } = await harness({
      pool,
      backend: flakyBackend(new MemoryStorageBackend(pool), [{ op: 'setGlobal', at: 1 }]),
    })
    await expect(registry.create({ title: 'doomed' })).rejects.toThrow('injected setGlobal failure')
    expect(registry.list()).toEqual([])
    const survivor = await registry.create({ title: 'after rollback' })
    expect(registry.get(survivor.id)?.title).toBe('after rollback')
  })

  it('restores the registry order when a delete record write fails', async () => {
    const pool = new MemoryMediaPool()
    const { registry } = await harness({
      pool,
      backend: flakyBackend(new MemoryStorageBackend(pool), [{ op: 'deleteRecord', at: 1 }]),
    })
    const objective = await registry.create({ title: 'delete rollback' })
    await expect(registry.delete(objective.id)).rejects.toThrow('injected deleteRecord failure')
    expect(registry.get(objective.id)?.title).toBe('delete rollback')
    expect(registry.list().map(entry => entry.title)).toEqual(['delete rollback'])
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
    await expect(registry.create({ title: 'doomed twice' })).rejects.toThrow(AggregateError)
    // The orphan record stays on the medium; the next startup fails loud on it.
    await expect(harness({ pool })).rejects.toThrow(/absent from registry order/)
  })

  it('reports both failures when a delete rollback also fails', async () => {
    const pool = new MemoryMediaPool()
    const { registry } = await harness({
      pool,
      backend: flakyBackend(new MemoryStorageBackend(pool), [
        { op: 'deleteRecord', at: 1 },
        { op: 'setGlobal', at: 3 },
      ]),
    })
    const objective = await registry.create({ title: 'stuck delete' })
    await expect(registry.delete(objective.id)).rejects.toThrow(AggregateError)
  })

  it('keeps the committed domain membership when the session-log mirror fails', async () => {
    const { ctx, registry } = await harness({ withSessions: false })
    ctx.provide('sessions', {
      get: () => ({
        append: () => {
          throw new Error('mirror boom')
        },
      }),
      list: () => [],
    } as never)
    const objective = await registry.create({ title: 'mirrored' })
    const attached = await registry.attachSession(objective.id, SessionId('member-mirror-fail'))
    expect(attached.sessionIds).toEqual([SessionId('member-mirror-fail')])
  })

  it('rejects mutations before the registry has started', async () => {
    const ctx = new Context()
    const registry = new ObjectiveRegistry(ctx)
    await expect(registry.create({ title: 'early' })).rejects.toThrow('not started yet')
    expect(() => registry.list()).toThrow('not started yet')
  })

  it('folds mixed logs by ignoring non-membership events', async () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'objective/member', seq: 1, time: 0, data: { version: 1, objectiveId: 'objective-m', title: 'm', action: 'attach' } },
    ] as never as Parameters<typeof foldObjectiveMembership>[0]
    expect(foldObjectiveMembership(events)).toHaveLength(1)
  })
})
