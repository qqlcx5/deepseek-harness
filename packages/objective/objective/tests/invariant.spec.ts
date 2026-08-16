import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ObjectiveRegistry, { ObjectiveId } from '../src/index.ts'
import type { ObjectiveMemberMeta } from '../src/index.ts'
import * as ObjectiveInvariantCompanion from '../src/invariant.ts'

const canonical: ObjectiveMemberMeta = {
  version: 1,
  objectiveId: ObjectiveId('objective-x'),
  title: 'convergence layers',
  action: 'attach',
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(ObjectiveRegistry)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ObjectiveInvariantCompanion)
  return ctx
}

describe('objective stream invariants', () => {
  it('accepts registry-written membership events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('objective-invariant-valid'))
    const objective = await ctx.objectives.create({ title: 'convergence layers' })
    await expect(ctx.objectives.attachSession(objective.id, session.id)).resolves.toBeTruthy()
    // Non-membership events pass through the companion untouched, and a fresh
    // session created after the companion loads walks the seed path with an
    // empty log.
    const fresh = ctx.sessions.create(SessionId('objective-invariant-fresh'))
    fresh.append('turn/start', { turn: 1 })
    expect(fresh.seq).toBe(1)
  })

  it('rejects a malformed membership event before committing it and keeps the session usable', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('objective-invariant-invalid'))
    const before = session.seq
    expect(() => {
      session.append('objective/member', { ...canonical, title: '' })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-objective',
    }))
    expect(session.seq).toBe(before)
    expect(() => {
      session.append('objective/member', canonical)
    }).not.toThrow()
  })

  it('rejects an unknown action and an unknown version the same way', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('objective-invariant-variants'))
    expect(() => {
      session.append('objective/member', { ...canonical, action: 'join' } as never)
    }).toThrow(InvariantError)
    expect(() => {
      session.append('objective/member', { ...canonical, version: 2 } as never)
    }).toThrow(InvariantError)
    expect(session.seq).toBe(0)
  })

  it('checks already-loaded sessions when the companion arrives late', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(ObjectiveRegistry)
    // No invariant companion is loaded yet, so the malformed event commits.
    const session = ctx.sessions.create(SessionId('objective-invariant-late-load'))
    session.append('objective/member', { ...canonical, objectiveId: '' } as never)

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(ObjectiveInvariantCompanion)).rejects.toThrow(InvariantError)
  })
})
