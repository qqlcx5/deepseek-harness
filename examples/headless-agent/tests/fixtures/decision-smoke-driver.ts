#!/usr/bin/env node
/** Decision-layer smoke driver: boots the real composition through the
 * Loader, drives the decision lifecycle end to end (create, counter-evidence,
 * irreversible two-pass decide, review, objective aggregation), and prints
 * one JSON summary line. No model call happens. */

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { ObjectiveId } from '@deepseek-ai/dsh-objective'

const NAME = 'decision-smoke-driver'
const [configPath] = process.argv.slice(2)
if (configPath === undefined) throw new Error(`${NAME}: expected <config-path>`)

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const objective = await ctx.objectives.create({ title: 'stabilize rulelift', northStar: 'no open P0s' })
  const decision = await ctx.decisions.create({
    question: 'Repair rulelift or rewrite it?',
    objectiveId: objective.id,
    reversibility: 'irreversible',
    options: [
      { label: 'repair', evidence: 'cheapest path', cost: '3 days' },
      { label: 'rewrite', evidence: 'removes the bug class', risk: 'regression window' },
    ],
  })
  await ctx.decisions.update(decision.id, {
    recommendation: 'repair',
    rationale: 'lowest cost now',
    confidence: 0.7,
    counterEvidence: 'rewrite removes the whole class of bugs; repair does not',
  })
  // The irreversible gate: the first pass must reject.
  let gated = false
  try {
    await ctx.decisions.decide(decision.id, 'repair')
  } catch (error) {
    gated = error instanceof Error && (error as { code?: string }).code === 'DECISION_IRREVERSIBLE_CONFIRM'
  }
  const stamped = ctx.decisions.get(decision.id)
  if (stamped === undefined) throw new Error('decision vanished before the confirming pass')
  const decided = await ctx.decisions.decide(decision.id, 'repair', {
    confirm: true,
    expectedUpdatedAt: stamped.updatedAt,
  })
  const review = await ctx.decisions.recordReview(decision.id, 'P0s closed, no regressions')
  const trail = ctx.decisions.reviewsByObjective(ObjectiveId(objective.id))
  process.stdout.write(`${JSON.stringify({
    type: 'decision-smoke',
    gated,
    status: decided.status,
    chosen: decided.chosen,
    predictedConfidence: decided.predictedConfidence,
    counterEvidenceRecorded: decided.counterEvidence.length > 0,
    reviewOutcome: review.actualOutcome,
    trailUnderObjective: trail.length,
  })}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
