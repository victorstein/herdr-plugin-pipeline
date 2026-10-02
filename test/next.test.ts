import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdNext } from '../src/cli'
import { newRun, saveRun } from '../src/lib/ledger'
import { formatNext, type TriageOutput, type TriageRecommendation } from '../src/lib/next'
import type { Task } from '../src/lib/types'
import { beadTaskFields } from './helpers/bead-fields'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'next-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

const rec = (id: string, over: Partial<TriageRecommendation> = {}): TriageRecommendation => ({
  id, title: `Bead ${id}`, score: 0.5, labels: null, reasons: null, unblocks_ids: null, claimable: true, ...over,
})

const TRIAGE: TriageOutput = {
  triage: {
    status: { PageRank: { state: 'computed' }, Betweenness: { state: 'timeout', reason: 'budget exceeded' } },
    recommendations_by_track: [
      {
        track_id: 'track-A', reason: 'Actionable now - can work in parallel',
        recommendations: [
          rec('hp-3', { title: 'Meter', score: 0.82, labels: ['ui'], reasons: ['unblocks 2', 'P1'], unblocks_ids: ['hp-5', 'hp-6'] }),
          rec('hp-4', { title: 'Tile', reasons: [] }),
          rec('hp-7', { title: 'Held one', score: 0.9 }),
          rec('hp-1', { title: 'Epic', claimable: false }),
        ],
      },
      { track_id: 'track-B', reason: 'Becomes actionable after layer 0 completes', recommendations: [rec('hp-5'), rec('hp-6')] },
      { track_id: 'track-C', reason: 'Becomes actionable after layer 1 completes', recommendations: [rec('hp-8')] },
      { track_id: 'track-ALL', reason: 'Cyclic dependencies detected', recommendations: [rec('hp-10'), rec('hp-11')] },
    ],
    blockers_to_clear: [{ id: 'hp-2', title: 'Schema', unblocks_ids: ['hp-3', 'hp-4'] }],
    alerts: [{ type: 'stale', severity: 'warning', message: 'hp-9 untouched for 30 days' }],
  },
  source_authority: { claim_safe: true },
}

const ALL = { limit: 5, label: null }

test('the actionable layer lists its claimable picks; later layers and the cyclic one get a line each', () => {
  expect(formatNext(TRIAGE, new Set(), ALL)).toBe([
    'warning: betweenness: timeout — budget exceeded',
    'now (parallel when their --files are disjoint):',
    '  hp-7 "Held one" score 0.90',
    '  hp-3 "Meter" score 0.82 — unblocks 2 → frees hp-5, hp-6',
    '  hp-4 "Tile" score 0.50',
    '  not claimable: hp-1',
    'after track-A: track-B hp-5, hp-6',
    'after track-B: track-C hp-8',
    'cyclic, until the cycle is broken: hp-10, hp-11',
    'blockers to clear:',
    '  hp-2 "Schema" → frees hp-3, hp-4',
    'alerts:',
    '  [warning] stale: hp-9 untouched for 30 days',
  ].join('\n'))
})

test('held beads are dropped from every layer, and a layer they empty is skipped', () => {
  const text = formatNext(TRIAGE, new Set(['hp-7', 'hp-5', 'hp-6']), ALL)
  expect(text).not.toContain('Held one')
  expect(text).not.toContain('track-B hp')
  expect(text).toContain('after track-B: track-C hp-8')
})

test('--label keeps only beads carrying it, and --limit caps the picks', () => {
  expect(formatNext(TRIAGE, new Set(), { limit: 5, label: 'ui' })).not.toContain('"Tile"')
  const capped = formatNext(TRIAGE, new Set(), { limit: 1, label: null })
  expect(capped).toContain('  hp-7 "Held one"')
  expect(capped).not.toContain('"Meter"')
})

test('a layer with nothing claimable says so, and an empty triage says nothing is there to pick up', () => {
  const blocked: TriageOutput = {
    triage: { recommendations_by_track: [{ track_id: 'track-A', reason: '', recommendations: [rec('hp-8', { claimable: false })] }] },
  }
  expect(formatNext(blocked, new Set(), ALL)).toBe('now: nothing claimable\n  not claimable: hp-8')
  expect(formatNext({ triage: {} }, new Set(), ALL)).toBe('nothing to pick up: every open bead is held, blocked or filtered out')
})

test('real bv output: routine skipped and approx metrics stay quiet, a timeout warns', () => {
  const skipped = { state: 'skipped' }
  const real: TriageOutput = {
    triage: {
      status: {
        PageRank: { state: 'computed' }, Betweenness: { state: 'approx', reason: 'sampled 50 nodes' },
        Eigenvector: skipped, HITS: skipped, Critical: skipped, Cycles: { state: 'timeout' },
        KCore: skipped, Articulation: skipped, Slack: skipped,
      },
      recommendations_by_track: [{ track_id: 'track-A', reason: '', recommendations: [rec('hp-3')] }],
      blockers_to_clear: null,
      alerts: null,
    },
    source_authority: { claim_safe: true },
  }
  expect(formatNext(real, new Set(), ALL)).toBe([
    'warning: cycles: timeout',
    'now (parallel when their --files are disjoint):',
    '  hp-3 "Bead hp-3" score 0.50',
  ].join('\n'))
})

test('an export bv cannot vouch for warns that the picks are blanked', () => {
  const blanked: TriageOutput = {
    triage: { recommendations_by_track: [{ track_id: 'track-A', recommendations: [rec('hp-3', { claimable: false })] }] },
    source_authority: { claim_safe: false },
  }
  expect(formatNext(blanked, new Set(), ALL)).toStartWith('warning: bv blanked every pick')
})

test('long id lists and alert lists are capped', () => {
  const many = Array.from({ length: 10 }, (_, i) => rec(`hp-${i + 20}`))
  const alerts = Array.from({ length: 7 }, (_, i) => ({ type: 'stale', severity: 'info', message: `a${i}` }))
  const text = formatNext({
    triage: { recommendations_by_track: [{ track_id: 'track-A', recommendations: [] }, { track_id: 'track-B', recommendations: many }], alerts },
  }, new Set(), ALL)
  expect(text).toContain('track-B hp-20, hp-21, hp-22, hp-23, hp-24, hp-25, hp-26, hp-27 +2 more')
  expect(text).toContain('  [info] stale: a4\n  +2 more')
  expect(text).not.toContain('a5')
})

test('hpipe next filters by what live runs in any session hold', async () => {
  const run = newRun({ session: 'work', socketPath: '/s', repoKey: 'k2', repoRoot: '/r2', title: 'b' })
  run.tasks = [{
    task_id: 't1', branch: 'b', bead: 'hp-7', surface: 'core', depends_on: [], files: [], keep_worktree: false,
    workspace_id: null, pane_id: null, agent_status: 'unknown', phase: 'implement', phase_entered_at: 0,
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null, checkout_path: null,
    registered_at: 0, adopted_at: null, artifacts: { research: null, spec: null, plan: null, verdicts: {} },
    merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [], decision_from: null,
    pending_answer: null, delivery_attempts: 0, notes: '',
  } satisfies Task]
  await saveRun(dir, run)

  const result = await cmdNext(ctx(), { repoKey: 'k', limit: 5, label: null }, async () => TRIAGE)
  expect(result.ok).toBe(true)
  expect(result.text).not.toContain('Held one')
  expect(result.text).toContain('"Meter"')
})

test('hpipe next fails with the reason when triage cannot run, and refuses a bad --limit', async () => {
  const missing = await cmdNext(ctx(), { repoKey: 'k', limit: 5, label: null },
    async () => ({ reason: 'unavailable', error: 'bv did not run (ENOENT) — brew install dicklesworthstone/tap/bv' }))
  expect(missing.ok).toBe(false)
  expect(missing.text).toContain('brew install dicklesworthstone/tap/bv')

  const bad = await cmdNext(ctx(), { repoKey: 'k', limit: 0, label: null }, async () => TRIAGE)
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('--limit must be a positive whole number')
})
