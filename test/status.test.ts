import { expect, test } from 'bun:test'
import { formatStatus } from '../src/lib/status'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

const mkRun = (): Run =>
  newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'chat meter' })

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false,
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'working',
  phase: 'implement', phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null,
  checkout_path: null, registered_at: Date.now(), adopted_at: Date.now(),
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  ...over,
})

test('names all four supervisor states', () => {
  for (const state of ['live', 'stale', 'none', 'other-session'] as const) {
    expect(formatStatus([], { state }, 'personal')).toContain(state)
  }
})

test('lists a run with its phase', () => {
  expect(formatStatus([mkRun()], { state: 'live' }, 'personal')).toContain('intake')
})

test('says so plainly when there are no runs', () => {
  expect(formatStatus([], { state: 'live' }, 'personal')).toContain('no active runs')
})

test('warns when the supervisor is not live, because nothing advances then', () => {
  expect(formatStatus([mkRun()], { state: 'none' }, 'personal')).toContain('nothing will advance')
})

test('reports an orchestrator pane that no longer exists', () => {
  const run = mkRun()
  run.orchestrator_pane = 'w4:p9'
  // A genuinely empty set is indistinguishable from "the herdr call failed" and
  // deliberately disables the check (see formatStatus's livePanes.size > 0
  // guard), so this must exercise "gone" with some other pane known live.
  const text = formatStatus([run], { state: 'live' }, 'personal', new Set(['w1:p1']))
  expect(text).toContain('orchestrator pane w4:p9 is gone')
  expect(text).toContain('claim')
})

test('does not warn when the pane is live', () => {
  const run = mkRun()
  run.orchestrator_pane = 'w1:p1'
  const text = formatStatus([run], { state: 'live' }, 'personal', new Set(['w1:p1']))
  expect(text).not.toContain('is gone')
})

test('status lists an open decision with its age and question', () => {
  const run = mkRun()
  run.tasks = [mkTask({
    task_id: 't1', phase: 'blocked-on-decision',
    decisions: [{
      id: 'd1', asked_at: Date.now() - 42 * 60_000, from_phase: 'implement',
      question: 'which cache?', recommendation: 'redis',
      answer: null, answered_by: null, answered_at: null, prompted_at: null,
    }],
  })]
  const text = formatStatus([run], { state: 'live' }, 'personal')
  expect(text).toContain('which cache?')
  expect(text).toContain('42m')
})

test('status names an answered-but-undelivered decision', () => {
  const run = mkRun()
  run.tasks = [mkTask({
    task_id: 't1', phase: 'blocked-on-decision',
    pending_answer: 'd1', delivery_attempts: 5,
    decisions: [{
      id: 'd1', asked_at: Date.now() - 60_000, from_phase: 'implement',
      question: 'which cache?', recommendation: 'redis',
      answer: 'redis', answered_by: 'human', answered_at: Date.now(), prompted_at: Date.now(),
    }],
  })]
  const text = formatStatus([run], { state: 'live' }, 'personal')
  expect(text).toContain('answered but undelivered')
})

test('status names who holds the files a blocked task is waiting on', () => {
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'failed', files: ['a/'] }),
    mkTask({ task_id: 't2', phase: 'blocked-on-files', files: ['a/'] }),
  ]
  const text = formatStatus([run], { state: 'live' }, 'personal')
  expect(text).toContain('t2 blocked on files held by t1 (failed)')
})

test('status flags a run whose intake was never closed', () => {
  const run = mkRun()
  run.phase = 'execute'
  run.intake_closed = false
  run.tasks = [mkTask({ task_id: 't1', phase: 'done' })]
  const text = formatStatus([run], { state: 'live' }, 'personal')
  expect(text).toContain('hpipe dispatch --done')
})

test('a healthy run produces none of the four new warning lines', () => {
  const run = mkRun()
  run.phase = 'execute'
  run.intake_closed = true
  run.tasks = [mkTask({ task_id: 't1', phase: 'implement', files: ['a/'] })]
  const text = formatStatus([run], { state: 'live' }, 'personal')
  expect(text).not.toContain('blocked on an open decision')
  expect(text).not.toContain('answered but undelivered')
  expect(text).not.toContain('blocked on files held by')
  expect(text).not.toContain('hpipe dispatch --done')
})

test('status tells the human to abort a run from an earlier plugin version', () => {
  const run = mkRun()
  ;(run as { schema_version?: number }).schema_version = undefined
  const text = formatStatus([run], { state: 'live' }, 'personal')
  expect(text).toContain(
    `run ${run.run_id} was started by an earlier plugin version and cannot be advanced ` +
    `— hpipe abort ${run.run_id} to release the repo.`,
  )
})

test('a healthy holder is reported as finishing, not as needing release', () => {
  // Live-run finding: `hpipe release` refuses an in-flight task, so advising it
  // against a healthy holder sends the human at a command that bounces.
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'implement', files: ['src/lib/'] }),
    mkTask({ task_id: 't2', phase: 'blocked-on-files', files: ['src/lib/config.ts'] }),
  ]
  const text = formatStatus([run], { state: 'live' }, 'personal')
  expect(text).toContain('blocked on files held by t1 (implement)')
  expect(text).toContain('waiting for it to finish')
  expect(text).not.toContain('hpipe release --task t1')
})

test('a stuck holder is still reported as needing release', () => {
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'failed', files: ['src/lib/'] }),
    mkTask({ task_id: 't2', phase: 'blocked-on-files', files: ['src/lib/config.ts'] }),
  ]
  expect(formatStatus([run], { state: 'live' }, 'personal')).toContain('hpipe release --task t1')
})

test('an escalated task is called out as needing a human', () => {
  const run = mkRun()
  run.tasks = [mkTask({ phase: 'escalated', escalated_from: 'implement',
                        phase_entered_at: Date.now() - 47 * 60_000 })]
  const out = formatStatus([run], { state: 'live' }, 'personal')
  expect(out).toContain('t1 escalated from implement')
  expect(out).toContain('47m')
  expect(out).toContain('hpipe rewind')
})

test('a healthy task gets no escalation warning', () => {
  const run = mkRun()
  run.tasks = [mkTask({ phase: 'implement' })]
  expect(formatStatus([run], { state: 'live' }, 'personal')).not.toContain('needs a human')
})

test('an escalated run is called out too', () => {
  const run = mkRun()
  run.phase = 'escalated'
  run.escalated_from = 'branch-review'
  run.phase_entered_at = Date.now() - 12 * 60_000
  const out = formatStatus([run], { state: 'live' }, 'personal')
  expect(out).toContain('escalated from branch-review')
  expect(out).toContain('needs a human')
})

test('an ABORTED run is not reported as escalated', () => {
  // cmdAbort overloads escalated_from: it sets it and then parks the run in
  // `done` (src/cli.ts:298-299). Keying on escalated_from !== null would warn
  // about every aborted run.
  const run = mkRun()
  run.escalated_from = 'execute'
  run.phase = 'done'
  expect(formatStatus([run], { state: 'live' }, 'personal')).not.toContain('needs a human')
})

test('an idle worker with no artifact is called out with its phase, age and path', () => {
  const run = mkRun()
  const entered = Date.now() - 12 * 60_000
  run.tasks = [mkTask({
    phase: 'research', phase_entered_at: entered, agent_status: 'idle',
    artifact_missing: { at: entered, path: '/wt/docs/research/r.md', candidates: [] },
  })]
  const out = formatStatus([run], { state: 'live' }, 'personal')
  expect(out).toContain('⚠ t1 idle in research 12m with nothing at /wt/docs/research/r.md')
  expect(out).toContain('its branch added no document to adopt')
})

test('an ambiguous missing artifact names every candidate', () => {
  const run = mkRun()
  run.tasks = [mkTask({
    phase: 'spec', phase_entered_at: 0,
    artifact_missing: { at: 0, path: '/wt/s.md', candidates: ['docs/a.md', 'docs/b.md'] },
  })]
  const out = formatStatus([run], { state: 'live' }, 'personal')
  expect(out).toContain('2 candidates, too many to adopt: docs/a.md, docs/b.md')
})

test('a missing-artifact record from an earlier phase entry is not reported', () => {
  const run = mkRun()
  run.tasks = [mkTask({
    phase: 'spec', phase_entered_at: 99,
    artifact_missing: { at: 0, path: '/wt/r.md', candidates: [] },
  })]
  expect(formatStatus([run], { state: 'live' }, 'personal')).not.toContain('with nothing at')
})
