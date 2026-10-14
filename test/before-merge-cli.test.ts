import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BeforeMergeReads, cmdAbort, cmdAnswer, cmdClose, cmdConfirm, cmdHold, cmdRewind,
} from '../src/cli'
import { openDecision } from '../src/lib/decisions'
import { loadRun, saveRun } from '../src/lib/ledger'
import { BEFORE_MERGE_CAPABILITY } from '../src/lib/pidfile'
import type { PrView } from '../src/lib/gh'
import type { Run, Task } from '../src/lib/types'
import { CHECKED_HEAD, checkOf, heldTask, NEWER_HEAD, perTaskRun, ruling, singlePrRun } from './helpers/before-merge'

let dir: string
const ROOT = join(import.meta.dir, '..')
const ctx = () => ({ stateDir: dir, pluginRoot: ROOT, session: 'personal' })
const ORCHESTRATOR = 'w1:p1'

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'before-merge-cli-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const saved = async (run: Run): Promise<Run> => (await loadRun(dir, 'personal', run.run_id))!
const taskOf = (run: Run, id = 't1'): Task => run.tasks.find((t) => t.task_id === id)!

interface Counted extends BeforeMergeReads { calls: string[] }

/** No supervisor, an open unmerged PR at the checked head, and every branch on origin at the checked head. */
function reads(over: Partial<BeforeMergeReads> = {}): Counted {
  const calls: string[] = []
  const unmerged: PrView = { merged: false, mergedAtMs: null, mergeCommit: null, headSha: CHECKED_HEAD }
  const base: BeforeMergeReads = {
    supervisor: async () => ({ state: 'none' }),
    prView: async () => unmerged,
    branchHead: async () => ({ ok: true, sha: CHECKED_HEAD }),
    ...over,
  }
  return {
    calls,
    supervisor: () => { calls.push('supervisor'); return base.supervisor() },
    prView: (repoRoot, pr) => { calls.push(`pr ${pr}`); return base.prView(repoRoot, pr) },
    branchHead: (repoRoot, branch) => { calls.push(`head ${branch}`); return base.branchHead(repoRoot, branch) },
  }
}

async function seeded(run: Run): Promise<Run> {
  await saveRun(dir, run)
  return run
}

const hold = (run: Run, checks: string[], taskId: string | null, deps = reads(), callerPane: string | null = ORCHESTRATOR) =>
  cmdHold(ctx(), { checks, taskId, repoKey: null, runId: run.run_id, callerPane }, deps)

const confirm = (
  run: Run, checkId: string, over: { waive?: string; failed?: string; by?: string; pane?: string | null } = {},
  deps = reads(),
) => cmdConfirm(ctx(), {
  checkId, by: over.by ?? 'human', waive: over.waive ?? null, failed: over.failed ?? null,
  repoKey: null, runId: run.run_id, callerPane: over.pane === undefined ? ORCHESTRATOR : over.pane,
}, deps)

// ——— answer --before-merge ———

async function asking(): Promise<Run> {
  const task = heldTask({ phase: 'blocked-on-decision', decision_from: 'implement', pr: null, ci: null, ci_head: undefined })
  openDecision(task, { question: 'ghosting?', recommendation: 'fix it' })
  return seeded(perTaskRun([task]))
}

test('answer --before-merge records each check, from that decision, in the answer\'s own save', async () => {
  const run = await asking()
  const before = run.revision ?? 0
  const out = await cmdAnswer(ctx(), {
    task: 't1', decision: 'd1', answer: 'fix the ghost', by: 'orchestrator', repoKey: null, runId: run.run_id,
    beforeMerge: ['no ghost after a page turn', 'the menu, still, closes'], callerPane: ORCHESTRATOR,
  }, reads())
  expect(out.ok, out.text).toBe(true)
  expect(out.text).toContain('recorded answer to d1 on t1; pending delivery')
  expect(out.text).toContain(`c1 recorded on t1: t1's PR does not merge until the human rules on "no ghost after a page turn"`)
  const after = await saved(run)
  expect(after.revision).toBe(before + 1)
  expect(taskOf(after).before_merge?.map((c) => [c.id, c.check, c.decision, c.recorded_pane])).toEqual([
    ['c1', 'no ghost after a page turn', 'd1', ORCHESTRATOR], ['c2', 'the menu, still, closes', 'd1', ORCHESTRATOR],
  ])
  expect(taskOf(after).pending_answer).toBe('d1')
})

test('answer --before-merge refuses an empty check, and records neither the answer nor the check', async () => {
  const run = await asking()
  for (const empty of ['', '  ', '--run']) {
    const out = await cmdAnswer(ctx(), {
      task: 't1', decision: 'd1', answer: 'a', by: 'human', repoKey: null, runId: run.run_id,
      beforeMerge: [empty], callerPane: ORCHESTRATOR,
    }, reads())
    expect(out.ok, JSON.stringify(empty)).toBe(false)
  }
  expect(taskOf(await saved(run)).pending_answer).toBeNull()
  expect(taskOf(await saved(run)).before_merge).toBeUndefined()
})

// ——— hold ———

test('hold records a task check per-task, and a run check single-PR', async () => {
  const perTask = await seeded(perTaskRun([heldTask({ phase: 'pr-review' })]))
  const onTask = await hold(perTask, ['no ghost after a page turn'], 't1')
  expect(onTask.text).toBe('c1 recorded on t1: PR #255 does not merge until the human rules on "no ghost after a page turn"')

  const batch = await seeded(singlePrRun([heldTask({ phase: 'implement', landed: [] })], 'execute'))
  const onRun = await hold(batch, ['the menu closes on a long press'], null)
  expect(onRun.text).toBe('c1 recorded: the batch PR does not merge until the human rules on "the menu closes on a long press"')
  const onBatchTask = await hold(batch, ['no ghost'], 't1')
  expect(onBatchTask.text).toBe('c2 recorded on t1: the batch PR does not merge until the human rules on "no ghost"; ' +
    't1 still lands on batch/x as usual')
  expect((await saved(batch)).before_merge?.map((c) => c.id)).toEqual(['c1'])
})

test('hold refuses what it cannot hold, and records nothing', async () => {
  const landed = [{ title: 'fix: x', land_sha: 'abc', at: 1 }]
  const cases: Array<[string, Run, string | null, Counted, string | null, string]> = [
    ['per-task with no task', perTaskRun([heldTask()]), null, reads(), ORCHESTRATOR,
      'a per-task run has no merge of its own: hold one task\'s merge with `--task <id>`'],
    ['a landed single-PR task', singlePrRun([heldTask({ phase: 'done', landed })], 'execute'), 't1', reads(), ORCHESTRATOR,
      't1 has landed on `batch/x`: a check of what ships is the batch\'s — '],
    ['a finished task', perTaskRun([heldTask({ phase: 'failed' })]), 't1', reads(), ORCHESTRATOR, 't1 is finished'],
    ['a merge recorded', perTaskRun([heldTask({ merged_at_ms: 5 })]), 't1', reads(), ORCHESTRATOR,
      'PR #255 has merged: there is no merge left to hold'],
    ['a merge GitHub reports', perTaskRun([heldTask()]), 't1',
      reads({ prView: async () => ({ merged: true, mergedAtMs: 5, headSha: CHECKED_HEAD }) }), ORCHESTRATOR,
      'PR #255 has merged: there is no merge left to hold'],
    ['gh failing', perTaskRun([heldTask()]), 't1', reads({ prView: async () => null }), ORCHESTRATOR,
      'could not ask GitHub whether PR #255 has merged; run it again'],
    ['no HERDR_PANE_ID', perTaskRun([heldTask()]), 't1', reads(), null, 'run it from a pane of this herdr session'],
    ['an old supervisor', perTaskRun([heldTask()]), 't1', reads({
      supervisor: async () => ({ state: 'live', info: {
        pid: 4242, pane_pid: 1, started_at_ms: 1, session: 'personal', socket_path: '/s', pane_id: 'w0:p1', schemas: [3, 4],
      } }),
    }), ORCHESTRATOR, 'the supervisor of session personal (pid 4242) predates before-merge checks'],
  ]
  for (const [name, run, taskId, deps, pane, refusal] of cases) {
    await seeded(run)
    const out = await hold(run, ['no ghost'], taskId, deps, pane)
    expect(out.ok, name).toBe(false)
    expect(out.text, name).toContain(refusal)
    expect(checksOf(await saved(run)), name).toEqual([])
  }
})

const checksOf = (run: Run): string[] =>
  [...run.tasks.flatMap((t) => t.before_merge ?? []), ...(run.before_merge ?? [])].map((c) => c.id)

test('hold refuses a worker\'s pane, from any run in the session', async () => {
  const run = await seeded(perTaskRun([heldTask()]))
  const other = perTaskRun([heldTask({ task_id: 't1', pane_id: 'w9:p1' })])
  other.run_id = 'other-run'
  other.repo_key = 'other'
  await seeded(other)
  for (const pane of ['w7:p1', 'w9:p1']) {
    const out = await hold(run, ['no ghost'], 't1', reads(), pane)
    expect(out.ok, pane).toBe(false)
    expect(out.text).toContain('a worker raises a decision; the orchestrator records the check')
  }
})

test('a pane a finished task or an undriven run still records is no worker\'s: herdr reuses workspace ids', async () => {
  const finished = heldTask({ task_id: 't2', branch: 'feat/old', bead: 'hp-2', phase: 'done', merged_at_ms: 1, pane_id: 'w3:p1' })
  const failed = heldTask({ task_id: 't3', branch: 'feat/dead', bead: 'hp-3', phase: 'failed', pane_id: 'w4:p1' })
  const run = await seeded(perTaskRun([heldTask({ before_merge: [checkOf('c1')] }), finished, failed]))
  const aborted = perTaskRun([heldTask({ phase: 'implement', pane_id: 'w9:p1' })])
  aborted.run_id = 'aborted-run'
  aborted.repo_key = 'other'
  aborted.phase = 'done'
  const parked = perTaskRun([heldTask({ phase: 'implement', pane_id: 'w8:p1' })])
  parked.run_id = 'parked-run'
  parked.repo_key = 'parked'
  parked.phase = 'escalated'
  parked.escalated_from = 'execute'
  await seeded(aborted)
  await seeded(parked)
  for (const pane of ['w3:p1', 'w4:p1', 'w9:p1', 'w8:p1']) {
    const held = await hold(run, ['no ghost'], 't1', reads(), pane)
    expect(held.ok, `hold from ${pane}: ${held.text}`).toBe(true)
  }
  const ruled = await confirm(run, 'c1', { pane: 'w9:p1' })
  expect(ruled.ok, ruled.text).toBe(true)
})

test('a supervisor that honours before-merge checks lets hold through', async () => {
  const run = await seeded(perTaskRun([heldTask({ phase: 'ci' })]))
  const out = await hold(run, ['no ghost'], 't1', reads({
    supervisor: async () => ({ state: 'live', info: {
      pid: 4242, pane_pid: 1, started_at_ms: 1, session: 'personal', socket_path: '/s', pane_id: 'w0:p1',
      capabilities: [BEFORE_MERGE_CAPABILITY],
    } }),
  }))
  expect(out.ok, out.text).toBe(true)
})

test('hold at an open gate replaces the merge prompt still queued for it with the hold', async () => {
  const run = perTaskRun([heldTask()])
  run.outbox = [{
    id: 'm1', to: 'orchestrator', task_id: 't1', entered_at: 1_000, text: 'gh pr merge 255 --squash', queued_at: 1, attempts: 0,
  }]
  await seeded(run)
  const out = await hold(run, ['no ghost'], 't1')
  expect(out.text).toContain('t1 is in merge now: do not run the merge command you were given; it comes again once c1 is confirmed')
  const outbox = (await saved(run)).outbox ?? []
  expect(outbox).toHaveLength(1)
  expect(outbox[0]?.text).toStartWith('# Hold — PR #255')
  expect(outbox[0]?.text).not.toContain('gh pr merge')

  const batch = await seeded(singlePrRun([]))
  const atShip = await hold(batch, ['the menu closes'], null)
  expect(atShip.text).toContain('the run is in ship-merge now: do not run the merge commands you were given')
  expect((await saved(batch)).outbox?.[0]?.text).toStartWith('# Hold — the batch PR #301')
})

// ——— confirm ———

test('confirm is accepted only near the gate it holds', async () => {
  const cases: Array<[string, Run, string]> = [
    ['per-task pr-review', perTaskRun([heldTask({ phase: 'pr-review', before_merge: [checkOf('c1')] })]),
      'c1 is ruled on at the merge it holds: t1 is in pr-review; confirm it once t1 reaches ci'],
    ['per-task ci before a head', perTaskRun([heldTask({ phase: 'ci', ci_head: undefined, before_merge: [checkOf('c1')] })]),
      "CI has not read t1's head yet: run it again after the next poll"],
    ['single-PR ship', withRunCheck(singlePrRun([], 'ship')),
      'c1 is ruled on at the merge it holds: the run is in ship; confirm it once the run reaches ship-ci'],
    ['single-PR ship-ci before a head', withRunCheck(singlePrRun([], 'ship-ci'), (r) => { delete r.batch!.ci_head }),
      "CI has not read the batch PR's head yet: run it again after the next poll"],
  ]
  for (const [name, run, refusal] of cases) {
    await seeded(run)
    const out = await confirm(run, 'c1')
    expect(out.ok, name).toBe(false)
    expect(out.text, name).toContain(refusal)
  }
})

function withRunCheck(run: Run, adjust: (run: Run) => void = () => {}): Run {
  run.before_merge = [checkOf('c1')]
  adjust(run)
  return run
}

test('only the human confirms, and a waiver and a failure are one ruling at a time', async () => {
  const run = await seeded(perTaskRun([heldTask({ before_merge: [checkOf('c1')] })]))
  expect((await confirm(run, 'c1', { by: 'orchestrator' })).text).toContain(
    'only the human confirms a before-merge check: `--by human` once they have made it, or `--by human --waive "<why>"`')
  expect((await confirm(run, 'c1', { waive: 'x', failed: 'y' })).ok).toBe(false)
  expect((await confirm(run, 'c1', { waive: ' ' })).ok).toBe(false)
  expect((await confirm(run, 'c9')).text).toContain('no such check')
  expect((await confirm(run, 'c1', { pane: 'w7:p1' })).ok).toBe(false)
  expect(taskOf(await saved(run)).before_merge?.[0]?.resolutions).toEqual([])
})

test('a confirmation reads the branch live, and covers only the head CI ran on', async () => {
  const run = await seeded(perTaskRun([heldTask({ before_merge: [checkOf('c1')] })]))
  const moved = await confirm(run, 'c1', {}, reads({ branchHead: async () => ({ ok: true, sha: NEWER_HEAD }) }))
  expect(moved.text).toBe('`feat/ghost` is at 5e6f7a8b, not 9e06c261, the head CI ran on: a check of 9e06c261 does not ' +
    'cover it; wait for the next prompt')
  const unread = await confirm(run, 'c1', {}, reads({ branchHead: async () => ({ ok: false, reason: 'offline' }) }))
  expect(unread.ok).toBe(false)
  expect(taskOf(await saved(run)).before_merge?.[0]?.resolutions).toEqual([])

  const deps = reads()
  const out = await confirm(run, 'c1', {}, deps)
  expect(out.ok, out.text).toBe(true)
  expect(deps.calls).toEqual(['pr 255', 'head feat/ghost'])
  expect(taskOf(await saved(run)).before_merge?.[0]?.resolutions).toMatchObject([{ as: 'confirmed', head: CHECKED_HEAD, pane: ORCHESTRATOR }])
})

test('the last ruling at an open gate queues the merge prompt in place of the hold, and re-arms the ladder', async () => {
  const run = perTaskRun([heldTask({ before_merge: [checkOf('c1'), checkOf('c2')] })])
  run.outbox = [{ id: 'h1', to: 'orchestrator', task_id: 't1', entered_at: 1_000, text: '# Hold — …', queued_at: 1, attempts: 0 }]
  await seeded(run)
  const first = await confirm(run, 'c1')
  expect(first.text).toBe('c1 confirmed by the human on 9e06c261; c2 is still owed before t1 merges')
  expect((await saved(run)).outbox?.map((e) => e.id)).toEqual(['h1'])

  const before = Date.now()
  const last = await confirm(run, 'c2', { waive: 'release window' })
  expect(last.text).toBe('c2 waived by the human: release window; nothing more is owed before t1 merges: its merge ' +
    'prompt is queued for you')
  const after = await saved(run)
  expect(after.outbox).toHaveLength(1)
  expect(after.outbox?.[0]?.text).toContain(`gh pr merge 255 --squash --match-head-commit ${CHECKED_HEAD}`)
  expect(taskOf(after).stall?.last_probe_at).toBeGreaterThanOrEqual(before)
  expect(taskOf(after).stall?.at).toBe(taskOf(after).phase_entered_at)
})

test('a waiver reads nothing and records no head; a ruling in ci queues nothing', async () => {
  const run = await seeded(perTaskRun([heldTask({ phase: 'ci', before_merge: [checkOf('c1')] })]))
  const deps = reads()
  const out = await confirm(run, 'c1', { waive: 'not testable on device' }, deps)
  expect(out.text).toBe("c1 waived by the human: not testable on device; nothing is queued: t1's merge prompt comes when it " +
    'reaches merge')
  expect(deps.calls).toEqual(['pr 255'])
  expect(taskOf(await saved(run)).before_merge?.[0]?.resolutions).toMatchObject([{ as: 'waived', head: null }])
  expect((await saved(run)).outbox ?? []).toEqual([])
})

test('after a merge, a confirmation reads no branch and queues nothing: the next tick moves the task on', async () => {
  const run = await seeded(perTaskRun([heldTask({ merged_at_ms: 5, merge_commit: 'm1', before_merge: [checkOf('c1')] })]))
  const deps = reads()
  const out = await confirm(run, 'c1', {}, deps)
  expect(out.text).toBe('c1 confirmed by the human on 9e06c261; nothing more is owed, and t1 has merged: the supervisor ' +
    'moves it on at its next pass')
  expect(deps.calls).toEqual([])
  expect((await saved(run)).outbox ?? []).toEqual([])
})

test('a per-task failure, from ci or merge, sends the task back to implement from the PR head, with check-failed', async () => {
  for (const phase of ['ci', 'merge'] as const) {
    const run = await seeded(perTaskRun([heldTask({ phase, passes: { ci: 1 }, before_merge: [checkOf('c1', [], { decision: 'd1' })] })]))
    const deps = reads({ prView: async () => ({ merged: false, mergedAtMs: null, headSha: NEWER_HEAD }) })
    const out = await confirm(run, 'c1', { failed: 'a ghost on page 3' }, deps)
    expect(out.text, phase).toBe('c1 failed on 5e6f7a8b: t1 goes back to implement; its prompt is queued for w7:p1')
    expect(deps.calls, phase).toEqual(['pr 255'])
    const after = taskOf(await saved(run))
    expect(after).toMatchObject({ phase: 'implement', head_sha_at_entry: NEWER_HEAD, passes: { ci: 1 } })
    expect(after.before_merge?.[0]?.resolutions).toMatchObject([{ as: 'failed', head: NEWER_HEAD, note: 'a ghost on page 3' }])
    const history = (await saved(run)).history.at(-1)
    expect(history?.why).toBe("the human's before-merge check c1 failed: a ghost on page 3")
    const queued = (await saved(run)).outbox?.find((e) => e.to === 'worker')
    expect(queued?.text).toStartWith("# The human's check failed — feat/ghost (hp-1), PR #255")
  }
})

test('a single-PR failure keeps the run where it is, on the live head only, and names both routes', async () => {
  const run = await seeded(withRunCheck(singlePrRun([])))
  const moved = await confirm(run, 'c1', { failed: 'stays open' },
    reads({ branchHead: async () => ({ ok: true, sha: NEWER_HEAD }) }))
  expect(moved.ok).toBe(false)
  expect(moved.text).toContain('`batch/x` is at 5e6f7a8b, not 9e06c261')

  const out = await confirm(run, 'c1', { failed: 'stays open' })
  expect(out.ok, out.text).toBe(true)
  expect(out.text).toContain('c1 failed on 9e06c261: the run stays in ship-merge until a fix moves the head')
  expect(out.text).toMatch(/ batch-check`, or a fix task through `.* task …`/)
  expect((await saved(run)).phase).toBe('ship-merge')
})

test('a failure after the merge is refused, and points at a waiver naming the fix', async () => {
  const run = await seeded(perTaskRun([heldTask({ before_merge: [checkOf('c1')] })]))
  const out = await confirm(run, 'c1', { failed: 'ghost' },
    reads({ prView: async () => ({ merged: true, mergedAtMs: 5, headSha: CHECKED_HEAD }) }))
  expect(out.text).toBe('PR #255 has merged: the fix is a new task. Record this ruling with ' +
    '`--waive "failed on device; fixed by <task>"` so the run can finish.')
})

test('confirm lands against a live supervisor, making each GitHub and git read once, before its retried save', async () => {
  const run = await seeded(perTaskRun([heldTask({ before_merge: [checkOf('c1')] })]))
  const timer = setInterval(async () => {
    const meanwhile = await saved(run)
    meanwhile.history.push({ at: Date.now(), from: 'x', to: 'x', why: 'a supervisor tick' })
    await saveRun(dir, meanwhile).catch(() => {})
  }, 100)
  const slow = reads({
    prView: async () => { await Bun.sleep(300); return { merged: false, mergedAtMs: null, headSha: CHECKED_HEAD } },
    branchHead: async () => { await Bun.sleep(300); return { ok: true, sha: CHECKED_HEAD } },
  })
  const out = await confirm(run, 'c1', {}, slow).finally(() => clearInterval(timer))
  expect(out.ok, out.text).toBe(true)
  expect(slow.calls).toEqual(['pr 255', 'head feat/ghost'])
})

// ——— what cannot skip the wait ———

test('a merged task that owes a check cannot be rewound past its merge, nor closed', async () => {
  const run = await seeded(perTaskRun([heldTask({ merged_at_ms: 5, before_merge: [checkOf('c1')] })]))
  for (const phase of ['close', 'teardown', 'done', 'failed', 'orphaned', 'blocked-on-failure']) {
    const out = await cmdRewind(ctx(), { runId: run.run_id, phase, taskId: 't1' })
    expect(out.ok, phase).toBe(false)
    expect(out.text, phase).toContain('t1 owes c1 to the human:')
  }
  const closed = await cmdClose(ctx(), { taskId: 't1', repoKey: null, runId: run.run_id, force: false },
    async () => { throw new Error('no bead is closed while the hold stands') })
  expect(closed.ok).toBe(false)
  expect(closed.text).toContain('t1 owes c1 to the human')
  expect(taskOf(await saved(run)).phase).toBe('merge')
})

test('a merged task that owes a check cannot be rewound to a phase that forgets its merge, only back to merge', async () => {
  for (const phase of ['implement', 'research', 'pr-review', 'ci']) {
    const run = await seeded(perTaskRun([heldTask({ merged_at_ms: 5, before_merge: [checkOf('c1')] })]))
    const out = await cmdRewind(ctx(), { runId: run.run_id, phase, taskId: 't1' })
    expect(out.ok, phase).toBe(false)
    expect(out.text, phase).toContain(`a rewind to ${phase} would forget that merge`)
    expect(taskOf(await saved(run))).toMatchObject({ phase: 'merge', merged_at_ms: 5, pr: 255 })
  }
  const run = await seeded(perTaskRun([heldTask({ merged_at_ms: 5, before_merge: [checkOf('c1')] })]))
  expect((await cmdRewind(ctx(), { runId: run.run_id, phase: 'merge', taskId: 't1' })).ok).toBe(true)
  expect(taskOf(await saved(run)).pr).toBe(255)

  const unmerged = await seeded(perTaskRun([heldTask({ before_merge: [checkOf('c1')] })]))
  expect((await cmdRewind(ctx(), { runId: unmerged.run_id, phase: 'implement', taskId: 't1' }, async () => false)).ok)
    .toBe(true)
})

test('a rewind asks GitHub whether an unrecorded merge happened, and refuses on one', async () => {
  const run = await seeded(perTaskRun([heldTask({ before_merge: [checkOf('c1')] })]))
  const merged = await cmdRewind(ctx(), { runId: run.run_id, phase: 'done', taskId: 't1' }, async () => true)
  expect(merged.ok).toBe(false)
  const unknown = await cmdRewind(ctx(), { runId: run.run_id, phase: 'done', taskId: 't1' }, async () => null)
  expect(unknown.text).toContain('could not ask GitHub whether PR #255 has merged; run it again')

  const voided = await cmdRewind(ctx(), { runId: run.run_id, phase: 'done', taskId: 't1' }, async () => false)
  expect(voided.ok, voided.text).toBe(true)
  expect(taskOf(await saved(run)).phase).toBe('done')
})

test('abort lists what is still owed to the human, and how far each merge got', async () => {
  const run = await seeded(perTaskRun([
    heldTask({ before_merge: [checkOf('c1')] }),
    heldTask({ task_id: 't2', pr: 256, merged_at_ms: 5, before_merge: [checkOf('c2', [], { check: 'the menu closes' })] }),
    heldTask({ task_id: 't3', before_merge: [checkOf('c3', [ruling('waived', null, 'ok')])] }),
  ]))
  const out = await cmdAbort(ctx(), { runId: run.run_id })
  expect(out.text).toContain('still owed to the human: c1 (t1) the reader shows no ghost after a page turn — PR #255 is not merged')
  expect(out.text).toContain('still owed to the human: c2 (t2) the menu closes — PR #256 merged before it was confirmed')
  expect(out.text).not.toContain('c3')

  const batch = await seeded(withRunCheck(singlePrRun([], 'ship-ci')))
  expect((await cmdAbort(ctx(), { runId: batch.run_id })).text)
    .toContain('still owed to the human: c1 the reader shows no ghost after a page turn — the batch PR is not merged')
})

test('a merged task past its gate, as only an older CLI could leave one, can still be ruled on so the run finishes', async () => {
  const run = await seeded(perTaskRun([heldTask({ phase: 'done', merged_at_ms: 5, before_merge: [checkOf('c1')] })]))
  const out = await confirm(run, 'c1', { waive: 'checked by hand after the merge' })
  expect(out.text).toBe('c1 waived by the human: checked by hand after the merge; nothing more is owed, and t1 has ' +
    'merged: the supervisor moves it on at its next pass')
  expect(taskOf(await saved(run)).stall).toBeUndefined()
})

test('hold and answer --before-merge land against a live supervisor, asking GitHub and the supervisor once each', async () => {
  for (const command of ['hold', 'answer'] as const) {
    const task = command === 'hold'
      ? heldTask({ phase: 'ci' })
      : heldTask({ phase: 'blocked-on-decision', decision_from: 'ci' })
    if (command === 'answer') openDecision(task, { question: 'q', recommendation: 'r' })
    const run = await seeded(perTaskRun([task]))
    const timer = setInterval(async () => {
      const meanwhile = await saved(run)
      meanwhile.history.push({ at: Date.now(), from: 'x', to: 'x', why: 'a supervisor tick' })
      await saveRun(dir, meanwhile).catch(() => {})
    }, 100)
    const slow = reads({
      supervisor: async () => { await Bun.sleep(300); return { state: 'none' } },
      prView: async () => { await Bun.sleep(300); return { merged: false, mergedAtMs: null, headSha: CHECKED_HEAD } },
    })
    const out = await (command === 'hold'
      ? hold(run, ['no ghost'], 't1', slow)
      : cmdAnswer(ctx(), {
        task: 't1', decision: 'd1', answer: 'a', by: 'human', repoKey: null, runId: run.run_id,
        beforeMerge: ['no ghost'], callerPane: ORCHESTRATOR,
      }, slow)
    ).finally(() => clearInterval(timer))
    expect(out.ok, `${command}: ${out.text}`).toBe(true)
    expect(slow.calls, command).toEqual(['supervisor', 'pr 255'])
  }
})

test('at an open gate with no head CI read, which only a rewind leaves, a ruling is taken as given', async () => {
  const run = await seeded(perTaskRun([heldTask({ ci_head: undefined, before_merge: [checkOf('c1')] })]))
  const deps = reads()
  const out = await confirm(run, 'c1', {}, deps)
  expect(out.text).toBe('c1 confirmed by the human; nothing more is owed before t1 merges: its merge prompt is queued for you')
  expect(taskOf(await saved(run)).before_merge?.[0]?.resolutions).toMatchObject([{ as: 'confirmed', head: null }])

  const batch = await seeded(withRunCheck(singlePrRun([]), (r) => { delete r.batch!.ci_head }))
  const shipped = await confirm(batch, 'c1')
  expect(shipped.ok, shipped.text).toBe(true)
  expect(shipped.text).toContain('nothing more is owed before PR #301 merges')
})

test('a confirmation reads the branch before its retried save even while the window is shut, since a tick may open it', async () => {
  const run = await seeded(perTaskRun([heldTask({ phase: 'pr-review', before_merge: [checkOf('c1')] })]))
  const deps = reads()
  expect((await confirm(run, 'c1', {}, deps)).ok).toBe(false)
  expect(deps.calls).toEqual(['pr 255', 'head feat/ghost'])
})

test('a check recorded while a decision opened in merge waits says the merge command already given is not to be run', async () => {
  const task = heldTask({ phase: 'blocked-on-decision', decision_from: 'merge' })
  openDecision(task, { question: 'q', recommendation: 'r' })
  const run = await seeded(perTaskRun([task]))
  const held = await hold(run, ['no ghost'], 't1')
  expect(held.text).toContain('t1 goes back to merge once its answer is delivered, and the hold comes then: do not run ' +
    'the merge command you were given')
  const answered = await cmdAnswer(ctx(), {
    task: 't1', decision: 'd1', answer: 'a', by: 'human', repoKey: null, runId: run.run_id,
    beforeMerge: ['the menu closes'], callerPane: ORCHESTRATOR,
  }, reads())
  expect(answered.text).toContain('t1 goes back to merge once its answer is delivered, and the hold comes then')
})
