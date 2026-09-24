import { expect, test } from 'bun:test'
import { actionFor, formatStatus, formatTaskDetail } from '../src/lib/status'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

// Deliberately not `hpipe`: a GitHub install has no such binary on PATH, so
// every command status prints must be the rendered invocation it was handed.
const HP = 'bun run /p/src/cli.ts'

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
    expect(formatStatus([], { state }, 'personal', HP)).toContain(state)
  }
})

test('lists a run with its phase', () => {
  expect(formatStatus([mkRun()], { state: 'live' }, 'personal', HP)).toContain('intake')
})

test('says so plainly when there are no runs', () => {
  expect(formatStatus([], { state: 'live' }, 'personal', HP)).toContain('no active runs')
})

test('warns when the supervisor is not live, because nothing advances then', () => {
  expect(formatStatus([mkRun()], { state: 'none' }, 'personal', HP)).toContain('nothing will advance')
})

test('reports an orchestrator pane that no longer exists', () => {
  const run = mkRun()
  run.orchestrator_pane = 'w4:p9'
  // A genuinely empty set is indistinguishable from "the herdr call failed" and
  // deliberately disables the check (see formatStatus's livePanes.size > 0
  // guard), so this must exercise "gone" with some other pane known live.
  const text = formatStatus([run], { state: 'live' }, 'personal', HP, new Set(['w1:p1']))
  expect(text).toContain('orchestrator pane w4:p9 is gone')
  expect(text).toContain('claim')
})

test('does not warn when the pane is live', () => {
  const run = mkRun()
  run.orchestrator_pane = 'w1:p1'
  const text = formatStatus([run], { state: 'live' }, 'personal', HP, new Set(['w1:p1']))
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
  const text = formatStatus([run], { state: 'live' }, 'personal', HP)
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
  const text = formatStatus([run], { state: 'live' }, 'personal', HP)
  expect(text).toContain('answered but undelivered')
})

test('status names who holds the files a blocked task is waiting on', () => {
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'failed', files: ['a/'] }),
    mkTask({ task_id: 't2', phase: 'blocked-on-files', files: ['a/'] }),
  ]
  const text = formatStatus([run], { state: 'live' }, 'personal', HP)
  expect(text).toContain('t2 blocked on files held by t1 (failed)')
})

test('status flags a run whose intake was never closed', () => {
  const run = mkRun()
  run.phase = 'execute'
  run.intake_closed = false
  run.tasks = [mkTask({ task_id: 't1', phase: 'done' })]
  const text = formatStatus([run], { state: 'live' }, 'personal', HP)
  expect(text).toContain(`${HP} dispatch --done`)
})

test('a healthy run produces none of the four new warning lines', () => {
  const run = mkRun()
  run.phase = 'execute'
  run.intake_closed = true
  run.tasks = [mkTask({ task_id: 't1', phase: 'implement', files: ['a/'] })]
  const text = formatStatus([run], { state: 'live' }, 'personal', HP)
  expect(text).not.toContain('blocked on an open decision')
  expect(text).not.toContain('answered but undelivered')
  expect(text).not.toContain('blocked on files held by')
  expect(text).not.toContain('dispatch --done')
})

test('status tells the human to abort a run from an earlier plugin version', () => {
  const run = mkRun()
  ;(run as { schema_version?: number }).schema_version = undefined
  const text = formatStatus([run], { state: 'live' }, 'personal', HP)
  expect(text).toContain(
    `run ${run.run_id} was started by an earlier plugin version and cannot be advanced ` +
    `— ${HP} abort ${run.run_id} to release the repo.`,
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
  const text = formatStatus([run], { state: 'live' }, 'personal', HP)
  expect(text).toContain('blocked on files held by t1 (implement)')
  expect(text).toContain('waiting for it to finish')
  expect(text).not.toContain('release --task t1')
})

test('a stuck holder is still reported as needing release', () => {
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'failed', files: ['src/lib/'] }),
    mkTask({ task_id: 't2', phase: 'blocked-on-files', files: ['src/lib/config.ts'] }),
  ]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP)).toContain(`${HP} release --task t1`)
})

test('an escalated task is called out as needing a human', () => {
  const run = mkRun()
  run.tasks = [mkTask({ phase: 'escalated', escalated_from: 'implement',
                        phase_entered_at: Date.now() - 47 * 60_000 })]
  const out = formatStatus([run], { state: 'live' }, 'personal', HP)
  expect(out).toContain(
    `t1 feat/x (#1) [escalated 47m] — needs a human: \`${HP} rewind ${run.run_id} implement --task t1\``,
  )
  expect(out).not.toMatch(/(^|[^/])hpipe /m)
})

test('an escalated task names the rewind that abandons it, since the run waits on it', () => {
  const run = mkRun()
  run.tasks = [mkTask({ phase: 'escalated', escalated_from: 'implement' })]
  const out = formatStatus([run], { state: 'live' }, 'personal')
  expect(out).toContain(`\`hpipe rewind ${run.run_id} failed --task t1\` abandons it`)
})

test('a healthy task gets no escalation warning', () => {
  const run = mkRun()
  run.tasks = [mkTask({ phase: 'implement' })]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP)).not.toContain('needs a human')
})

test('an escalated run is called out too', () => {
  const run = mkRun()
  run.phase = 'escalated'
  run.escalated_from = 'branch-review'
  run.phase_entered_at = Date.now() - 12 * 60_000
  const out = formatStatus([run], { state: 'live' }, 'personal', HP)
  expect(out).toContain('escalated from branch-review')
  expect(out).toContain('needs a human')
  expect(out).toContain(`${HP} rewind ${run.run_id} branch-review`)
})

test('an ABORTED run is not reported as escalated', () => {
  // cmdAbort overloads escalated_from: it sets it and then parks the run in
  // `done` (src/cli.ts:298-299). Keying on escalated_from !== null would warn
  // about every aborted run.
  const run = mkRun()
  run.escalated_from = 'execute'
  run.phase = 'done'
  expect(formatStatus([run], { state: 'live' }, 'personal', HP)).not.toContain('needs a human')
})

test('every task line carries how long it has sat in its phase', () => {
  // A task 13 hours into `research` was visually identical to one 2 minutes in
  // on the berean-os run of 2026-09-16. Measured on a live run.
  const now = 100_000_000
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'research', phase_entered_at: now - 780 * 60_000 }),
    mkTask({ task_id: 't2', phase: 'implement', phase_entered_at: now - 2 * 60_000 }),
  ]
  const text = formatStatus([run], { state: 'live' }, 'personal', HP, new Set(), now)
  expect(text).toContain('  t1 feat/x #1 [research 780m] working')
  expect(text).toContain('  t2 feat/x #1 [implement 2m] working')
})

test('a PR parked in merge is named under waiting on you, not left among the rest', () => {
  const now = 100_000_000
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', branch: 'fix/a', issue: 30, phase: 'merge', pr: 41,
             phase_entered_at: now - 297 * 60_000 }),
    mkTask({ task_id: 't2', branch: 'fix/b', issue: 31, phase: 'implement' }),
  ]
  const text = formatStatus([run], { state: 'live' }, 'personal', HP, new Set(), now)
  const section = text.slice(text.indexOf('waiting on you:'))
  expect(section).toContain('t1 fix/a (#30) [merge 297m] — YOUR move')
  expect(section).not.toContain('t2')
})

test('waiting on you speaks the same clause as the digest for every task it lists', () => {
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'failed', files: ['src/a.ts'] }),
    mkTask({ task_id: 't2', phase: 'blocked-on-files', files: ['src/a.ts'] }),
    mkTask({ task_id: 't3', phase: 'blocked-on-decision' }),
    mkTask({ task_id: 't4', phase: 'escalated', escalated_from: 'plan' }),
  ]
  const text = formatStatus([run], { state: 'live' }, 'personal', HP)
  for (const task of run.tasks) {
    expect(text).toContain(`${task.task_id} feat/x (#1) [${task.phase} `)
    expect(text).toContain(`] — ${actionFor(run, task, HP)}`)
  }
})

test('nothing waiting on you prints no section at all', () => {
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'implement' }),
    mkTask({ task_id: 't2', phase: 'queued' }),
    mkTask({ task_id: 't3', phase: 'done' }),
  ]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP)).not.toContain('waiting on you')
})

test('an idle worker sitting on uncommitted work is waiting on you, not thinking', () => {
  const now = 100_000_000
  const run = mkRun()
  run.phase = 'execute'
  run.tasks = [mkTask({
    task_id: 't1', phase: 'implement', phase_entered_at: now - 30 * 60_000,
    uncommitted_work: { at: now - 30 * 60_000, count: 4, sample: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
  })]
  const text = formatStatus([run], { state: 'live' }, 'personal', HP, new Set(), now)
  expect(text).toContain(
    '    t1 feat/x (#1) [implement 30m] — YOUR move: worker idle with 4 uncommitted paths ' +
    '(src/a.ts, src/b.ts, src/c.ts, …) — have it commit and push',
  )
})

test('an uncommitted-work record that is not live is not reported', () => {
  const run = mkRun()
  run.phase = 'execute'
  const stale = mkTask({ task_id: 't1', phase: 'implement', phase_entered_at: 20,
                         uncommitted_work: { at: 10, count: 2, sample: ['a', 'b'] } })
  const clean = mkTask({ task_id: 't2', phase: 'implement', phase_entered_at: 20,
                         uncommitted_work: { at: 20, count: 0, sample: [] } })
  const paneless = mkTask({ task_id: 't3', phase: 'implement', phase_entered_at: 20, pane_id: null,
                            uncommitted_work: { at: 20, count: 2, sample: ['a', 'b'] } })
  run.tasks = [stale, clean, paneless]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP)).not.toContain('uncommitted')

  // A run parked in a pane-releasing phase is never evaluated again, so nothing clears it.
  run.phase = 'done'
  run.tasks = [mkTask({ phase: 'implement', phase_entered_at: 20,
                        uncommitted_work: { at: 20, count: 2, sample: ['a', 'b'] } })]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP)).not.toContain('uncommitted')
})

test('a stuck files block prints its release command once', () => {
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'failed', files: ['src/a.ts'] }),
    mkTask({ task_id: 't2', phase: 'blocked-on-files', files: ['src/a.ts'] }),
  ]
  const text = formatStatus([run], { state: 'live' }, 'personal', HP)
  expect(text.split(`${HP} release --task t1`)).toHaveLength(2)
  expect(text).toContain('t2 blocked on files held by t1 (failed) — it has stopped moving')
})

test('every stuck holder gets its own release command', () => {
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't1', phase: 'failed', files: ['src/a.ts'] }),
    mkTask({ task_id: 't2', phase: 'blocked-on-files', files: ['src/a.ts', 'src/b.ts'] }),
    mkTask({ task_id: 't3', phase: 'escalated', files: ['src/b.ts'] }),
  ]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP)).toContain(
    `— YOUR move: \`${HP} release --task t1\`, \`${HP} release --task t3\``,
  )
})

test('waiting on you is ordered by task id, as the digest footer is', () => {
  const run = mkRun()
  run.tasks = [
    mkTask({ task_id: 't2', phase: 'merge' }),
    mkTask({ task_id: 't1', phase: 'close' }),
  ]
  const text = formatStatus([run], { state: 'live' }, 'personal', HP)
  const section = text.slice(text.indexOf('waiting on you:'))
  expect(section.indexOf('t1 feat/x')).toBeLessThan(section.indexOf('t2 feat/x'))
})

test('an idle worker with no artifact is waiting on you, with its phase, age and path', () => {
  const now = 100_000_000
  const run = mkRun()
  const entered = now - 12 * 60_000
  run.tasks = [mkTask({
    phase: 'research', phase_entered_at: entered, agent_status: 'idle',
    artifact_missing: { at: entered, path: '/wt/docs/research/r.md', candidates: [] },
  })]
  const out = formatStatus([run], { state: 'live' }, 'personal', HP, new Set(), now)
  const section = out.slice(out.indexOf('waiting on you:'))
  expect(section).toContain(
    't1 feat/x (#1) [research 12m] — YOUR move: worker idle with nothing at ' +
    '/wt/docs/research/r.md (its branch added no document to adopt)',
  )
})

test('an ambiguous missing artifact names every candidate', () => {
  const run = mkRun()
  run.tasks = [mkTask({
    phase: 'spec', phase_entered_at: 0,
    artifact_missing: { at: 0, path: '/wt/s.md', candidates: ['docs/a.md', 'docs/b.md'] },
  })]
  const out = formatStatus([run], { state: 'live' }, 'personal', HP)
  expect(out).toContain('2 candidates, too many to adopt: docs/a.md, docs/b.md')
})

test('a missing-artifact record from an earlier phase entry is not reported', () => {
  const run = mkRun()
  run.tasks = [mkTask({
    phase: 'spec', phase_entered_at: 99,
    artifact_missing: { at: 0, path: '/wt/r.md', candidates: [] },
  })]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP)).not.toContain('with nothing at')
})

test('an aborted run does not report a missing artifact its supervisor stopped clearing', () => {
  const run = mkRun()
  run.phase = 'done'
  run.tasks = [mkTask({
    phase: 'research', phase_entered_at: 0,
    artifact_missing: { at: 0, path: '/wt/r.md', candidates: [] },
  })]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP)).not.toContain('with nothing at')
})

test('a paneless worker does not report a missing artifact the supervisor never re-evaluates', () => {
  const run = mkRun()
  run.tasks = [mkTask({
    phase: 'research', phase_entered_at: 0, pane_id: null,
    artifact_missing: { at: 0, path: '/wt/r.md', candidates: [] },
  })]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP)).not.toContain('with nothing at')
})

test('status lists a worktree with no agent detected in it as waiting on you — #12', () => {
  const now = 10_000_000
  const run = mkRun()
  run.phase = 'execute'
  run.tasks = [mkTask({
    task_id: 't1', phase: 'research', workspace_id: 'w23', pane_id: null,
    phase_entered_at: now - 12 * 60_000, adopted_at: now - 12 * 60_000,
  })]
  const text = formatStatus([run], { state: 'live' }, 'personal', HP, new Set(), now)
  expect(text).toContain('waiting on you:')
  expect(text).toContain('t1 feat/x (#1) [research 12m] — YOUR move: no agent detected in its worktree')
  expect(text).toContain('herdr pane list --workspace w23')
  expect(text).toContain(`\`${HP} dispatch --task t1 --pane <pane>\``)
})

test('status does not flag a worktree whose agent may still be booting — #12', () => {
  const now = 10_000_000
  const run = mkRun()
  run.phase = 'execute'
  run.tasks = [mkTask({ phase: 'research', pane_id: null, adopted_at: now })]
  expect(formatStatus([run], { state: 'live' }, 'personal', HP, new Set(), now))
    .not.toContain('no agent')
})

test('hpipe show names the pane a failed worker last ran in — #12', () => {
  const run = mkRun()
  const task = mkTask({ phase: 'failed', pane_id: null, last_pane_id: 'w7:p1' })
  run.tasks = [task]
  expect(formatTaskDetail(run, task)).toContain('pane:       none (last: w7:p1)')
})
