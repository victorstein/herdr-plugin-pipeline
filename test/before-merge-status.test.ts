import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { actionFor, formatStatus, formatTaskDetail, waitsOnYou } from '../src/lib/status'
import type { Run } from '../src/lib/types'
import { renderRunPhasePrompt } from '../src/supervisor/deliver'
import { parkedFooter } from '../src/supervisor/tick'
import { CHECKED_HEAD, checkOf, heldTask, NEWER_HEAD, perTaskRun, ruling, singlePrRun } from './helpers/before-merge'

const ROOT = join(import.meta.dir, '..')
const HP = 'hp'
const NOW = 1_000 + 34 * 60_000

const status = (run: Run): string => formatStatus([run], { state: 'live' }, 'personal', HP, new Set(), NOW)

function held(over: Parameters<typeof heldTask>[0] = {}): Run {
  const run = perTaskRun([heldTask({
    before_merge: [
      checkOf('c1', [], { decision: 'd1' }),
      checkOf('c3', [ruling('confirmed', CHECKED_HEAD)], { check: 'the menu closes on a long press' }),
    ],
    ...over,
  })])
  run.run_id = 'r1'
  return run
}

test('a held task is the human\'s wait, not yours, and status says so in its own block', () => {
  const run = held()
  const task = run.tasks[0]!
  expect(waitsOnYou(run, task, NOW)).toBe(false)
  expect(actionFor(run, task, HP, NOW)).toBe('waiting on the human (c1)')

  const text = status(run)
  expect(text).toContain('  t1 feat/ghost hp-1 [merge 34m] heavy agent:idle PR #255 ci:pass — waiting on the human (c1)')
  expect(text).toContain('  before merge: c1 (t1) the reader shows no ghost after a page turn — waiting on the human · ' +
    'c3 (t1) the menu closes on a long press — confirmed by the human on 9e06c261')
  expect(text).toContain('  waiting on the human:\n' +
    '    c1 t1 [merge 34m] — the reader shows no ghost after a page turn (from d1), on PR #255 at 9e06c261 — once they ' +
    'answer: `hp confirm --check c1 --by human` (or --waive / --failed)')
  expect(text).not.toContain('waiting on you:')
})

test('before its gate, status and show say when the human is asked, and list nothing under their wait', () => {
  const run = held({ phase: 'research', pr: null, ci: null, ci_head: undefined })
  const text = status(run)
  expect(text).toContain("  before merge: c1 (t1) the reader shows no ghost after a page turn — owed before t1's PR merges; " +
    'the human is asked at merge · c3 (t1) the menu closes on a long press — confirmed by the human on 9e06c261')
  expect(text).not.toContain('waiting on the human')
  expect(formatTaskDetail(run, run.tasks[0]!, NOW)).toContain('before merge: c1 the reader shows no ghost after a page ' +
    "turn (from d1) — owed before t1's PR merges; the human is asked at merge")

  const batch = singlePrRun([], 'execute')
  batch.run_id = 'r1'
  batch.before_merge = [checkOf('c2', [], { check: 'the menu closes' })]
  expect(status(batch)).toContain('  before merge: c2 the menu closes — owed before PR #301 merges; the human is asked at ' +
    'ship-merge')
  expect(status(batch)).not.toContain('waiting on the human')
})

test('a stale confirmation shows the head it covered and the head there is now', () => {
  const run = held({ before_merge: [checkOf('c1', [ruling('confirmed', NEWER_HEAD)])] })
  expect(status(run)).toContain('on PR #255 at 9e06c261 (confirmed on 5e6f7a8b; the head is now 9e06c261) — once they answer')
})

test('a merge made while held is a warning, and the execute backstop is a run line under the human\'s wait', () => {
  const merged = held({ merged_at_ms: 5 })
  expect(status(merged)).toContain('  ⚠ t1: PR #255 merged before the human confirmed c1 — it waits in merge until c1 is ' +
    'confirmed or waived')

  const pastItsGate = held({ phase: 'done', merged_at_ms: 5 })
  pastItsGate.intake_closed = true
  pastItsGate.phase_entered_at = 1_000
  expect(status(pastItsGate)).toContain('  waiting on the human:\n' +
    '    run [execute 34m] — t1 merged with c1 owed: confirm or waive it to let the run finish\n' +
    '    c1 t1 [done 34m] — the reader shows no ghost after a page turn (from d1), on PR #255 at 9e06c261')
})

test('a held ship-merge shows the human\'s wait in place of the merge; a check waiting on a fix is yours', () => {
  const run = singlePrRun([])
  run.run_id = 'r1'
  run.phase_entered_at = 1_000
  run.before_merge = [checkOf('c2', [], { check: 'the menu closes' })]
  const text = status(run)
  expect(text).toContain('  · PR #301 ci:pass (on 9e06c261)\n  nothing for you — PR #301 waits on the human for c2')
  expect(text).not.toContain('YOUR move: squash-merge')
  expect(text).toContain('    c2 run [ship-merge 34m] — the menu closes, on PR #301 at 9e06c261 — once they answer')

  run.before_merge = [checkOf('c2', [ruling('failed', CHECKED_HEAD, 'stays open')], { check: 'the menu closes' })]
  expect(status(run)).toContain('  YOUR move: c2 failed on 9e06c261 (stays open) — fix it on batch/x: a subagent\'s patch ' +
    'in the batch checkout, then `hp batch-check`, or a fix task through `hp task …`')
})

test('a run ended with a check owed says so', () => {
  const run = held()
  run.phase = 'done'
  run.escalated_from = 'execute'
  run.history.push({ at: 1, from: 'execute', to: 'done', why: 'aborted from execute' })
  expect(status(run)).toContain('  ⚠ ended with c1 (t1) still owed to the human: the reader shows no ghost after a page turn')
})

test('show prints one before-merge line per check, in each state', () => {
  const run = held()
  run.tasks[0]!.before_merge!.push(
    checkOf('c4', [ruling('waived', null, 'release window')], { check: 'w' }),
    checkOf('c5', [ruling('failed', NEWER_HEAD, 'a ghost')], { check: 'f' }),
  )
  const text = formatTaskDetail(run, run.tasks[0]!, NOW)
  expect(text).toContain('decision:   none\n' +
    'before merge: c1 the reader shows no ghost after a page turn (from d1) — waiting on the human\n' +
    '              c3 the menu closes on a long press — confirmed by the human on 9e06c261, 34m ago\n' +
    '              c4 w — waived by the human 34m ago: release window\n' +
    '              c5 f — failed on 5e6f7a8b, 34m ago: a ghost; the human checks the next head')
  const unmerged = perTaskRun([heldTask({ task_id: 't5', phase: 'failed', before_merge: [checkOf('c6')] })])
  expect(formatTaskDetail(unmerged, unmerged.tasks[0]!, NOW))
    .toContain('before merge: c6 the reader shows no ghost after a page turn — not needed: t5 never merged')
})

test('the digest footer shows the merge is held on purpose, unless the task\'s own prompt rides in it', () => {
  const run = held()
  expect(parkedFooter(run, new Set(), NOW, HP)).toBe('waiting on the human:\n' +
    '- c1 t1 [merge 34m] — the reader shows no ghost after a page turn (from d1), on PR #255 at 9e06c261 — once they ' +
    'answer: `hp confirm --check c1 --by human` (or --waive / --failed)')
  expect(parkedFooter(run, new Set(['t1']), NOW, HP)).toBe('')
})

test('the done notice says what was ruled before merge', async () => {
  const run = perTaskRun([
    heldTask({ phase: 'done', merged_at_ms: 2, pr: null, before_merge: [checkOf('c1', [ruling('confirmed', CHECKED_HEAD)])] }),
    heldTask({ task_id: 't5', phase: 'failed', pr: null, before_merge: [checkOf('c3')] }),
  ])
  run.phase = 'done'
  run.before_merge = []
  const text = await renderRunPhasePrompt(run, ROOT)
  expect(text).toContain('before merge: c1 (t1) confirmed by the human on 9e06c261 · c3 (t5) not needed: t5 never merged')
})
