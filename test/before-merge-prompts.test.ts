import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecision, answerDecision } from '../src/lib/decisions'
import type { Run, Task, TaskPhase } from '../src/lib/types'
import { renderRunPhasePrompt } from '../src/supervisor/deliver'
import { deliverPendingAnswers, renderTaskPhasePrompt } from '../src/supervisor/tasks'
import { CHECKED_HEAD, checkOf, heldTask, NEWER_HEAD, perTaskRun, ruling, singlePrRun } from './helpers/before-merge'

const ROOT = join(import.meta.dir, '..')
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'before-merge-prompts-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const prose = (text: string): string => text.replace(/\s+/g, ' ')

async function taskPrompt(run: Run, task: Task, cameFrom: TaskPhase = task.phase): Promise<string> {
  return renderTaskPhasePrompt(run, task, { pluginRoot: ROOT, ciDetail: async () => '' }, cameFrom)
}

function batchRun(phase: Run['phase'] = 'ship-merge'): Run {
  const run = singlePrRun([heldTask({ phase: 'done', merged_at_ms: 1, landed: [{ title: 'fix: x', land_sha: 'aaa', at: 1 }] })], phase)
  run.batch!.checkout = join(dir, 'checkouts', 'r1')
  run.batch!.checked = { head_sha: CHECKED_HEAD, at: 1, check: 'passed' }
  return run
}

test('a per-task merge owing a check renders the hold, which makes it mergeable first and never shows the merge', async () => {
  const task = heldTask({ before_merge: [checkOf('c1', [], { decision: 'd1' })] })
  const text = await taskPrompt(perTaskRun([task]), task)
  expect(text).toStartWith('# Hold — PR #255 (feat/ghost, hp-1) waits on the human before it merges')
  expect(text).toContain('- c1: the reader shows no ghost after a page turn (from d1)')
  expect(text).toContain('gh pr view 255 --json mergeStateStatus')
  expect(prose(text)).toContain('`BEHIND` or `DIRTY`: rebase the branch onto the default branch and push')
  expect(prose(text)).toContain('`DRAFT`: `gh pr ready 255`, which moves no head, then ask again.')
  expect(prose(text)).toContain('what to check and on which build: PR #255 at 9e06c261, the head CI passed on.')
  expect(text).toMatch(/ confirm --check <id> --by human --failed "<what they saw>"/)
  expect(text).not.toContain('gh pr merge')
  expect(text).not.toContain('{{')
})

test('a stale confirmation is named in the hold, and a confirmation on the gate head renders the merge again', async () => {
  const stale = heldTask({ before_merge: [checkOf('c1', [ruling('confirmed', NEWER_HEAD)])] })
  expect(await taskPrompt(perTaskRun([stale]), stale)).toContain('— confirmed on 5e6f7a8b; the head is now 9e06c261')

  const confirmed = heldTask({ before_merge: [checkOf('c1', [ruling('confirmed', CHECKED_HEAD)])] })
  const merge = await taskPrompt(perTaskRun([confirmed]), confirmed)
  expect(merge).toContain(`gh pr merge 255 --squash --match-head-commit ${CHECKED_HEAD}`)
})

test('a held ship-merge renders the hold for the batch PR, with the batch\'s way to be mergeable and built', async () => {
  const run = batchRun()
  run.before_merge = [checkOf('c2', [], { check: 'the menu closes on a long press' })]
  run.tasks[0]!.before_merge = [checkOf('c1')]
  const text = await renderRunPhasePrompt(run, ROOT, { stateDir: dir })
  expect(text).toStartWith('# Hold — the batch PR #301 waits on the human before it merges')
  expect(text).toContain('PR #301, `batch/x` into `main`, waits on the human for:')
  expect(text).toContain('- c1 (t1): the reader shows no ghost after a page turn')
  expect(text).toContain('- c2: the menu closes on a long press')
  expect(prose(text)).toContain('`BEHIND`: `gh pr update-branch 301`.')
  expect(prose(text)).toContain('`batch/x` at 9e06c261, the head CI passed on.')
  expect(prose(text)).toContain('If you build it for them, build it in the batch checkout, brought up to date:')
  expect(text).toContain(`worktree add --track -B batch/x '${join(dir, 'checkouts', 'r1')}' origin/batch/x`)
  expect(text).not.toContain('gh pr merge')
  expect(text).not.toContain('{{')
})

test('a single-PR check that failed on the gate head names the routes to a fix', async () => {
  const run = batchRun()
  run.before_merge = [checkOf('c1', [ruling('failed', CHECKED_HEAD, 'the menu stays open')])]
  const text = prose(await renderRunPhasePrompt(run, ROOT, { stateDir: dir }))
  expect(text).toContain('— failed on 9e06c261: the menu stays open; waiting on a fix')
  expect(text).toContain('c1 failed on 9e06c261, so this hold also waits on a fix')
  expect(text).toMatch(/ batch-check`; or a fix task through `.* task …`/)
})

test('ship-merge says what was ruled before merge, and nothing when the run has no check', async () => {
  const plain = await renderRunPhasePrompt(batchRun(), ROOT, { stateDir: dir })
  expect(plain).not.toContain('Before merge')
  expect(plain).not.toContain('This is the last point')
  expect(plain).not.toMatch(/\n\n\n/)

  const run = batchRun()
  run.before_merge = [checkOf('c2', [ruling('confirmed', CHECKED_HEAD)])]
  run.tasks[0]!.before_merge = [checkOf('c1', [ruling('waived', null, 'release window')])]
  const text = await renderRunPhasePrompt(run, ROOT, { stateDir: dir })
  expect(text).toContain(`--match-head-commit ${CHECKED_HEAD}`)
  expect(text).toContain('Before merge: c1 (t1) waived by the human: release window; c2 confirmed by the human on 9e06c261.')
})

test('a task sent back by a failed check gets check-failed, carrying what the human saw and the implementer\'s brief', async () => {
  const task = heldTask({
    phase: 'implement', tier: 'standard',
    before_merge: [checkOf('c1', [ruling('failed', CHECKED_HEAD, 'a ghost on page 3')], { decision: 'd1' })],
  })
  const text = await taskPrompt(perTaskRun([task]), task, 'merge')
  expect(text).toStartWith("# The human's check failed — feat/ghost (hp-1), PR #255")
  expect(text).toContain('the reader shows no ghost after a page turn')
  expect(text).toContain('a ghost on page 3')
  expect(text).toContain('(from d1)')
  const implement = await taskPrompt(perTaskRun([task]), task, 'blocked-on-files')
  const brief = (t: string) => t.slice(t.indexOf("## The implementer's brief"))
  expect(brief(text)).toBe(brief(implement))
  expect(text).not.toContain('{{')
})

test('an answer that carries a check tells the worker to make it checkable, where its mode replies', async () => {
  for (const [run, place] of [
    [perTaskRun([]), 'the PR body'], [singlePrRun([], 'execute'), 'the message of an empty commit on the branch'],
  ] as const) {
    const task = heldTask({ phase: 'blocked-on-decision', decision_from: 'implement', pane_id: 'w7:p1' })
    openDecision(task, { question: 'q', recommendation: 'r' })
    answerDecision(task, 'd1', 'yes', 'human')
    task.pending_answer = 'd1'
    task.before_merge = [checkOf('c1', [], { decision: 'd1' }), checkOf('c2', [], { decision: 'd9', check: 'other' })]
    run.tasks = [task]
    const sent: string[] = []
    await deliverPendingAnswers(run, {
      pluginRoot: ROOT, promptRetryMax: 5,
      send: async (_pane, text) => { sent.push(text); return { ok: true } },
      checkSubmission: async () => ({ state: 'pending' }),
    })
    expect(sent[0]).toContain('Before this merges, the human will check:\n\n- the reader shows no ghost after a page turn\n\n' +
      `Make it checkable: say in ${place} how to check it.`)
    expect(sent[0]).not.toContain('other')
  }
})

test('the hold prompt\'s tokens are its own, so no common bag can shadow one', async () => {
  const template = await Bun.file(join(ROOT, 'prompts', 'before-merge.md')).text()
  const tokens = [...template.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]!)
  expect(tokens.length).toBeGreaterThan(0)
  for (const token of tokens) expect(token === 'hpipe' || token.startsWith('held_'), token).toBe(true)
})

test('decision, intake and ship teach the orchestrator to record a check only the human can make', async () => {
  const read = async (name: string) => prose(await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text())
  expect(await read('decision')).toContain('add `--before-merge "<what they check>"`: the merge is held until they ' +
    'confirm it. Not for anything you or the worker can verify — put that in the answer.')
  for (const name of ['intake', 'ship']) {
    expect(await read(name), name).toContain('If the user wants to check the work themselves before it merges, record ' +
      'it as soon as you know: `{{hpipe}} hold --before-merge "<check>"`')
  }
  expect(await read('intake')).toContain('`{{hpipe}} hold --task <id> --before-merge "<check>"`')
})

test('the README, the skill and the runbook teach hold, confirm and what a hold does', async () => {
  const readme = prose(await Bun.file(join(ROOT, 'README.md')).text())
  for (const needle of [
    '## Before-merge checks', 'hpipe hold --task <id> --before-merge "<check>"', 'hpipe hold --before-merge "<check>"',
    'hpipe confirm --check <id> --by human --waive "<why>"', 'never a task\'s landing', 'No stall probe comes for it',
    '`hold` and `answer --before-merge` refuse until this session\'s supervisor is restarted',
  ]) expect(readme, needle).toContain(needle)

  const skill = prose(await Bun.file(join(ROOT, 'skills', 'herdr-pipeline', 'SKILL.md')).text())
  for (const needle of ['answer, hold, confirm', '`--before-merge "<what they check>"`', '"Hold — … waits on the human ' +
    'before it merges"', 'hpipe confirm --check <id> --by human', '`waiting on the human:` in status or a digest']) {
    expect(skill, needle).toContain(needle)
  }

  const runbook = await Bun.file(join(ROOT, 'test', 'integration', 'smoke.md')).text()
  expect(runbook).toContain('## 11. Before-merge checks')
})

test('a task resumed into a merge that came to owe a check meanwhile sends the orchestrator the hold', async () => {
  const task = heldTask({ phase: 'blocked-on-decision', decision_from: 'merge', pane_id: 'w7:p1' })
  openDecision(task, { question: 'q', recommendation: 'r' })
  answerDecision(task, 'd1', 'yes', 'orchestrator')
  task.pending_answer = 'd1'
  task.before_merge = [checkOf('c1', [], { decision: 'd1' })]
  const run = perTaskRun([task])
  for (const state of ['pending', 'submitted'] as const) {
    await deliverPendingAnswers(run, {
      pluginRoot: ROOT, promptRetryMax: 5,
      send: async () => ({ ok: true }),
      checkSubmission: async () => ({ state }),
    })
  }
  expect(task.phase).toBe('merge')
  const queued = (run.outbox ?? []).filter((e) => e.to === 'orchestrator' && e.task_id === 't1')
  expect(queued).toHaveLength(1)
  expect(queued[0]?.entered_at).toBe(task.phase_entered_at)
  expect(queued[0]?.text).toStartWith('# Hold — PR #255')
})
