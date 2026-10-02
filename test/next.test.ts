import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdNext } from '../src/cli'
import { newRun, saveRun } from '../src/lib/ledger'
import { formatNext, type TriageByTrack } from '../src/lib/next'
import type { Task } from '../src/lib/types'
import { beadTaskFields } from './helpers/bead-fields'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'next-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

const TRIAGE: TriageByTrack = {
  status: {
    PageRank: { state: 'computed' },
    Cycles: { state: 'timeout', reason: 'budget exceeded' },
    Betweenness: { state: 'approx', reason: 'sampled 500 nodes' },
  },
  recommendations_by_track: [
    {
      track_id: 'A', reason: 'Independent work stream',
      top_pick: { id: 'hp-3', title: 'Meter', score: 0.82, reasons: ['unblocks 2'], unblocks: 2 },
      recommendations: [
        { id: 'hp-3', title: 'Meter', score: 0.82, labels: ['ui'], reasons: ['unblocks 2', 'P1'], unblocks_ids: ['hp-5', 'hp-6'], claimable: true },
        { id: 'hp-4', title: 'Tile', score: 0.5, labels: [], reasons: [], claimable: true },
      ],
    },
    {
      track_id: 'B',
      top_pick: { id: 'hp-7', title: 'Held one', score: 0.9, reasons: [], unblocks: 0 },
      recommendations: [{ id: 'hp-7', title: 'Held one', score: 0.9, labels: [], reasons: [], claimable: true }],
    },
  ],
  blockers_to_clear: [{ id: 'hp-2', title: 'Schema', unblocks_ids: ['hp-3', 'hp-4'] }],
  alerts: [{ type: 'stale', severity: 'warning', message: 'hp-9 untouched for 30 days' }],
}

const ALL = { limit: 5, label: null }

test('each track prints its top pick with score, reasons and what it unblocks, then its other ids', () => {
  expect(formatNext(TRIAGE, new Set(), ALL)).toBe([
    'warning: cycles: timeout — cycle-free not proven',
    'warning: betweenness: approx — sampled 500 nodes',
    'track A — Independent work stream',
    '  top: hp-3 "Meter" score 0.82 — unblocks hp-5, hp-6',
    '    why: unblocks 2; P1',
    '  also: hp-4',
    'track B',
    '  top: hp-7 "Held one" score 0.90',
    'blockers to clear:',
    '  hp-2 "Schema" — unblocks hp-3, hp-4',
    'alerts:',
    '  [warning] stale: hp-9 untouched for 30 days',
  ].join('\n'))
})

test('held beads are dropped: a held top pick yields to the next claimable bead, an emptied track goes', () => {
  const text = formatNext(TRIAGE, new Set(['hp-3', 'hp-7']), ALL)
  expect(text).toContain('track A — Independent work stream\n  top: hp-4 "Tile" score 0.50')
  expect(text).not.toContain('hp-3 "Meter"')
  expect(text).not.toContain('track B')
})

test('--label keeps only beads carrying it, and --limit caps the tracks', () => {
  expect(formatNext(TRIAGE, new Set(), { limit: 5, label: 'ui' })).not.toContain('also: hp-4')
  expect(formatNext(TRIAGE, new Set(), { limit: 1, label: null })).not.toContain('track B')
})

test('a track with nothing claimable says so, and an empty triage says nothing is there to pick up', () => {
  const blocked: TriageByTrack = {
    recommendations_by_track: [{ track_id: 'C', reason: '', recommendations: [{ id: 'hp-8', title: 'x', score: 0.1, labels: null, reasons: null, claimable: false }] }],
  }
  expect(formatNext(blocked, new Set(), ALL)).toBe('track C\n  no claimable pick\n  also: hp-8')
  expect(formatNext({}, new Set(), ALL)).toBe('nothing to pick up: every open bead is held, blocked or filtered out')
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
  expect(result.text).not.toContain('track B')
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
