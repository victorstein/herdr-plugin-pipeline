import { isTier, TIERS } from './phases'
import type { Run, Tier, TierChange } from './types'

export const TIER_LABEL_PREFIX = 'pipeline:tier-'

/** `null` when nothing was read: a bead `hpipe task` just filed carries no labels yet. */
export type LabelRead = string[] | null

export interface ChosenTier {
  ok: true
  tier: Tier
  source: TierChange['source']
  why: string
}

export type RegistrationTier = ChosenTier | { ok: false; error: string }

export function registrationTier(flagValue: string | undefined, labels: LabelRead): RegistrationTier {
  let flagTier: Tier | undefined
  if (flagValue !== undefined) {
    if (!isTier(flagValue)) {
      return { ok: false, error: `--tier must be one of ${TIERS.join(', ')}, got: ${flagValue}` }
    }
    flagTier = flagValue
  }

  const fallback: ChosenTier = flagTier === undefined
    ? { ok: true, tier: 'standard', source: 'default', why: 'default' }
    : { ok: true, tier: flagTier, source: 'flag', why: '--tier' }
  if (labels === null) return fallback

  const tierLabels = labels.filter((label) => label.startsWith(TIER_LABEL_PREFIX))
  if (tierLabels.length > 1) {
    return {
      ok: false,
      error: `the bead carries ${tierLabels.length} tier labels (${tierLabels.join(', ')}); ` +
        'remove all but one, then register it again',
    }
  }
  const [label] = tierLabels
  if (label === undefined) return fallback

  const named = label.slice(TIER_LABEL_PREFIX.length)
  if (!isTier(named)) {
    return {
      ok: false,
      error: `unknown tier label ${label}; the tier labels are ` +
        TIERS.map((tier) => `${TIER_LABEL_PREFIX}${tier}`).join(', '),
    }
  }
  return {
    ok: true, tier: named, source: 'label',
    why: flagTier === undefined ? `label ${label}` : `label ${label}; --tier said ${flagTier}`,
  }
}

export function isLowering(from: Tier, to: Tier): boolean {
  return TIERS.indexOf(to) < TIERS.indexOf(from)
}

/**
 * Every pane the pipeline put an agent in. A guard, not authentication: a pane
 * herdr renamed on a move, or an orchestrator rebound by `claim`, still carries
 * an id this set no longer holds. The prompts forbid lowering; this only stops an
 * agent that ignores them from its own pane.
 */
export function pipelinePanes(run: Run): Set<string> {
  const panes = new Set<string>()
  if (run.orchestrator_pane !== null) panes.add(run.orchestrator_pane)
  for (const task of run.tasks) {
    if (task.pane_id !== null) panes.add(task.pane_id)
    if (task.last_pane_id !== undefined) panes.add(task.last_pane_id)
  }
  return panes
}
