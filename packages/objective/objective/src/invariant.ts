/** Package-owned invariant companion for `@deepseek-ai/dsh-objective`. @module @deepseek-ai/dsh-objective/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { validateObjectiveMember } from '@deepseek-ai/dsh-objective'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-objective'

/** Cordis companion plugin name. */
export const name = 'objective-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Owned relationship: every `objective/member` event that enters a session
 * log must carry a canonical membership payload (vocabulary version,
 * non-empty objectiveId and title, and a known action). The registry is the
 * only writer and always writes canonical payloads, so a malformed event
 * proves a producer bypassed `ctx.objectives`; the check runs before the
 * candidate event commits, so a rejected event never enters the log.
 * Integrity detection, not plugin isolation: a same-process producer
 * appending a well-formed counterfeit is outside this companion's reach.
 */
const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    const check = (session: Session, event: SessionEvent, at: string): void => {
      if (event.type !== 'objective/member') return
      if (validateObjectiveMember(event.data) === undefined) {
        fail(
          `${at} of session '${session.id}' carries a malformed objective/member payload `
          + `(event ${event.seq}) — some write path bypassed ctx.objectives`,
        )
      }
    }
    /** Walk one already-recorded log; the late-load path and install-time seeding share it. */
    const seedSession = (session: Session): void => {
      for (const event of session.events) check(session, event, 'a loaded event')
    }
    for (const session of ctx.sessions.list()) seedSession(session)
    ctx.on('session/created', seedSession, { global: true })
    ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return
      const [session, event] = args as [Session, SessionEvent]
      check(session, event, 'a candidate session event')
    }, { global: true })
  },
  { inject: ['sessions'] },
)

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
