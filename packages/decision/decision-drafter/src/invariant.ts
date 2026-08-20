/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-decision-drafter`.
 * @module @deepseek-ai/dsh-decision-drafter/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-decision-drafter'

/** Cordis companion plugin name. */
export const name = 'decision-drafter-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this delegation consumer owns no independent state or event protocol;
 * the decision domain checks writes and the subagent seam checks the child run.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
