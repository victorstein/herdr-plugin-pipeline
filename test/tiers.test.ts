import { expect, test } from 'bun:test'
import { newRun } from '../src/lib/ledger'
import { isLowering, pipelinePanes, registrationTier } from '../src/lib/tiers'
import type { Task } from '../src/lib/types'

function refusal(result: ReturnType<typeof registrationTier>): string {
  if (result.ok) throw new Error(`expected a refusal, got tier ${result.tier}`)
  return result.error
}

test('with no tier label and no --tier the tier is standard', () => {
  expect(registrationTier(undefined, [])).toEqual({ ok: true, tier: 'standard', source: 'default', why: 'default' })
})

test('--tier alone is recorded as the flag', () => {
  expect(registrationTier('heavy', ['bug'])).toEqual({ ok: true, tier: 'heavy', source: 'flag', why: '--tier' })
})

test('one tier label wins over --tier, and the reason says what --tier said', () => {
  expect(registrationTier('standard', ['bug', 'pipeline:tier-light'])).toEqual({
    ok: true, tier: 'light', source: 'label', why: 'label pipeline:tier-light; --tier said standard',
  })
  expect(registrationTier(undefined, ['pipeline:tier-heavy'])).toEqual({
    ok: true, tier: 'heavy', source: 'label', why: 'label pipeline:tier-heavy',
  })
})

test('two tier labels are refused, naming both', () => {
  expect(refusal(registrationTier('light', ['pipeline:tier-light', 'pipeline:tier-heavy'])))
    .toContain('pipeline:tier-light, pipeline:tier-heavy')
})

test('an unknown tier label is refused', () => {
  expect(refusal(registrationTier(undefined, ['pipeline:tier-huge']))).toContain('pipeline:tier-huge')
})

test('an unknown --tier is refused even when no labels were read', () => {
  expect(refusal(registrationTier('huge', null))).toBe('--tier must be one of light, standard, heavy, got: huge')
})

test('unreadable labels fall back to --tier, else standard, and say why on one line', () => {
  const unreadable = { error: 'HTTP 401: Bad credentials\n(https://api.github.com)' }
  expect(registrationTier('heavy', unreadable)).toEqual({
    ok: true, tier: 'heavy', source: 'flag', why: '--tier; labels unreadable: HTTP 401: Bad credentials',
  })
  expect(registrationTier(undefined, unreadable)).toEqual({
    ok: true, tier: 'standard', source: 'default', why: 'default; labels unreadable: HTTP 401: Bad credentials',
  })
})

test('labels that were never read leave --tier, else the default', () => {
  expect(registrationTier(undefined, null)).toEqual({ ok: true, tier: 'standard', source: 'default', why: 'default' })
  expect(registrationTier('light', null)).toEqual({ ok: true, tier: 'light', source: 'flag', why: '--tier' })
})

test('lowering is any move toward light', () => {
  expect(isLowering('heavy', 'standard')).toBe(true)
  expect(isLowering('standard', 'light')).toBe(true)
  expect(isLowering('light', 'heavy')).toBe(false)
  expect(isLowering('standard', 'standard')).toBe(false)
})

test('the pipeline panes are the orchestrator and every task pane, live or last', () => {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = 'w1:p1'
  const task = (over: Partial<Task>): Task => ({
    task_id: 't1', branch: 'b', issue: 1, surface: 'core', depends_on: [], files: [],
    keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
    phase: 'implement', phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
    pr: null, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
    artifacts: { research: null, spec: null, plan: null, verdicts: {} },
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
    ...over,
  })
  run.tasks = [
    task({ task_id: 't1', pane_id: 'w7:p1' }),
    task({ task_id: 't2', pane_id: null, last_pane_id: 'w3:p1' }),
  ]
  expect([...pipelinePanes(run)].sort()).toEqual(['w1:p1', 'w3:p1', 'w7:p1'])
})
