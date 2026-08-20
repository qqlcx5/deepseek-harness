import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import DecisionRegistry from '../src/index.ts'
import * as DecisionInvariantCompanion from '../src/invariant.ts'

describe('decision invariant companion', () => {
  it('registers with the invariant service and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(DecisionRegistry)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const dispose = await DecisionInvariantCompanion.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })
})
