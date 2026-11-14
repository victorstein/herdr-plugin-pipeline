# herdr-pl-3 implementation plan: pane guards follow moved worker panes

Spec: `docs/superpowers/specs/2026-11-14-herdr-pl-3-design.md` (cleared review 0). Branch
`fix/moved-pane-guards`. Work in this worktree only. Commit after each task; **never push**.

FILES: src/lib/types.ts, src/supervisor/tick.ts, src/lib/unstarted.ts, src/lib/tiers.ts, src/cli.ts
FILES: test/tick.test.ts, test/unstarted.test.ts, test/tiers.test.ts, test/cli-commands.test.ts, test/before-merge-cli.test.ts

Rules for every step:
- Re-read each file before you edit it. A sibling task may have changed it since this plan was
  written, so match on the code you find, not on the line numbers below (they are from base
  `8514924`).
- Comments carry only a non-obvious *why*. Do not add a comment that restates the next line.
- Run single test files with `bun test <file>`. Before the final commit, `bunx tsc --noEmit` and
  `bun test` must both be green.
- Conventional-commit messages, each ending with the line
  `Claude-Session: https://claude.ai/code/session_01F3fK9hFDWkrq6nNwwXD6Yy`.

---

## Task 1 — the field, and a move records the old id

### Step 1.1: add the field (`src/lib/types.ts`)

In `interface Task`, directly after the `last_pane_id?: string` line (about line 273), insert:

```ts
  /**
   * The ids this task's live pane had before herdr renamed it on a move. Its agent
   * keeps the first one in `HERDR_PANE_ID`, so the guards that refuse a worker's
   * pane match these too. Deleted with the pane, because a dead pane's ids are free
   * for herdr to give someone else. Optional: ledgers written before herdr-pl-3 lack it.
   */
  former_pane_ids?: string[]
```

Run `bunx tsc --noEmit`. Expect no errors.

### Step 1.2: failing tests (`test/tick.test.ts`)

Find the test `'pane.moved rebinds the task to the pane\'s new id and fails nothing — #86'` (about
line 1138). Insert these two tests directly after it:

```ts
test('pane.moved keeps the id the pane had before, once per id — herdr-pl-3', () => {
  const run = mkRun([mkTask({ phase: 'research', pane_id: 'w3:p2' })])
  applyEvents([run], [{
    kind: 'pane.moved', session: 'personal', at: 1, pane_id: 'w5:p2', previous_pane_id: 'w3:p2',
  }], 'personal', new Set())
  expect(run.tasks[0]?.pane_id).toBe('w5:p2')
  expect(run.tasks[0]?.former_pane_ids).toEqual(['w3:p2'])

  applyEvents([run], [{
    kind: 'pane.moved', session: 'personal', at: 2, pane_id: 'w6:p1', previous_pane_id: 'w5:p2',
  }], 'personal', new Set())
  expect(run.tasks[0]?.pane_id).toBe('w6:p1')
  expect(run.tasks[0]?.former_pane_ids).toEqual(['w3:p2', 'w5:p2'])
})

test('a pane moved back to an id it had before is not listed twice — herdr-pl-3', () => {
  const run = mkRun([mkTask({ phase: 'research', pane_id: 'w5:p2', former_pane_ids: ['w3:p2'] })])
  applyEvents([run], [
    { kind: 'pane.moved', session: 'personal', at: 1, pane_id: 'w3:p2', previous_pane_id: 'w5:p2' },
    { kind: 'pane.moved', session: 'personal', at: 2, pane_id: 'w5:p2', previous_pane_id: 'w3:p2' },
  ], 'personal', new Set())
  expect(run.tasks[0]?.pane_id).toBe('w5:p2')
  expect(run.tasks[0]?.former_pane_ids).toEqual(['w3:p2', 'w5:p2'])
})
```

In the existing test `'a pane.moved that keeps the id changes nothing — #86'` (about line 1120),
add as its last line, after `expect(changed).toBe(false)`:

```ts
  expect(run.tasks[0]?.former_pane_ids).toBeUndefined()
```

In the existing test `'a moved pane still rebinds when herdr\'s own pane.moved was applied first —
#86'` (about line 1213), add as its last line, after `expect(run.tasks[0]?.phase).toBe('research')`:

```ts
  expect(run.tasks[0]?.former_pane_ids).toEqual(['w3:p2'])
```

Run `bun test test/tick.test.ts`. Expect three failures: the two new tests, and the "applied first"
test, which gets `undefined` instead of `['w3:p2']`. The "keeps the id" test passes.

### Step 1.3: implement (`src/supervisor/tick.ts`)

In `applyEvents`, in the `if (event.kind === 'pane.moved') {` branch (about lines 503-511), replace:

```ts
      if (found && event.pane_id !== undefined && event.pane_id !== event.previous_pane_id) {
        found.task.pane_id = event.pane_id
        changed = true
      }
```

with:

```ts
      if (found && event.pane_id !== undefined && event.previous_pane_id !== undefined &&
        event.pane_id !== event.previous_pane_id) {
        const former = found.task.former_pane_ids ?? []
        if (!former.includes(event.previous_pane_id)) {
          found.task.former_pane_ids = [...former, event.previous_pane_id]
        }
        found.task.pane_id = event.pane_id
        changed = true
      }
```

Leave the `findTask` line above it unchanged. It must keep matching on `t.pane_id` only (spec A6).

Run `bun test test/tick.test.ts`. Expect all to pass. Run `bunx tsc --noEmit`. Expect no errors.

### Step 1.4: commit

```
git add src/lib/types.ts src/supervisor/tick.ts test/tick.test.ts
git commit -m "fix: remember a moved worker pane's former ids

Claude-Session: https://claude.ai/code/session_01F3fK9hFDWkrq6nNwwXD6Yy"
```

---

## Task 2 — `holdsPane`, and the list goes with the pane (`src/lib/unstarted.ts`)

### Step 2.1: failing tests (`test/unstarted.test.ts`)

Change the import from `'../src/lib/unstarted'` at the top of the file to add `holdsPane` and
`releaseWorkerPane`:

```ts
import {
  bindWorkerPane, briefCommand, dispatchSequence, dispatchWorkerCommand, holdsPane, overdueUnstartedWorker,
  releaseWorkerPane, remainingDispatchSteps, startWorkerCommand, UNSTARTED_GRACE_MS, unstartedWorker,
} from '../src/lib/unstarted'
```

Insert directly after the test `'binding a pane re-arms the ladder from now; rebinding the same pane
changes nothing'` (about line 183):

```ts
test('a task holds its current pane and the ids that pane had before a move, and no other — herdr-pl-3', () => {
  const task = mkTask({ pane_id: 'w5:p2', former_pane_ids: ['w3:p2'], last_pane_id: 'w2:p1' })
  expect(holdsPane(task, 'w5:p2')).toBe(true)
  expect(holdsPane(task, 'w3:p2')).toBe(true)
  expect(holdsPane(task, 'w2:p1')).toBe(false)
  expect(holdsPane(mkTask({ pane_id: 'w5:p2' }), 'w3:p2')).toBe(false)
})

test('a released pane takes its former ids with it — herdr-pl-3', () => {
  const task = mkTask({ pane_id: 'w5:p2', former_pane_ids: ['w3:p2'] })
  releaseWorkerPane(task)
  expect(task.pane_id).toBeNull()
  expect(task.last_pane_id).toBe('w5:p2')
  expect(task.former_pane_ids).toBeUndefined()
})

test('binding a different pane drops the former ids; rebinding the same pane keeps them — herdr-pl-3', () => {
  const run = mkRun()
  const task = mkTask({ pane_id: 'w5:p2', former_pane_ids: ['w3:p2'] })
  expect(bindWorkerPane(run, task, 'w5:p2', NOW)).toBe(false)
  expect(task.former_pane_ids).toEqual(['w3:p2'])
  expect(bindWorkerPane(run, task, 'w9:p1', NOW)).toBe(true)
  expect(task.former_pane_ids).toBeUndefined()
})
```

Run `bun test test/unstarted.test.ts`. Expect it to fail: `holdsPane` is not exported, so the file
does not load.

### Step 2.2: implement (`src/lib/unstarted.ts`)

In `bindWorkerPane`, replace:

```ts
  if (task.pane_id === paneId) return false
  task.pane_id = paneId
```

with:

```ts
  if (task.pane_id === paneId) return false
  task.pane_id = paneId
  delete task.former_pane_ids
```

In `releaseWorkerPane`, replace:

```ts
  if (task.pane_id !== null) task.last_pane_id = task.pane_id
  task.pane_id = null
```

with:

```ts
  if (task.pane_id !== null) task.last_pane_id = task.pane_id
  task.pane_id = null
  delete task.former_pane_ids
```

Directly after the closing `}` of `releaseWorkerPane`, add:

```ts

/**
 * Whether `pane` is the task's pane, by its current id or one it had before a
 * move. A moved worker's `HERDR_PANE_ID` still carries the old id.
 */
export function holdsPane(task: Task, pane: string): boolean {
  return task.pane_id === pane || (task.former_pane_ids?.includes(pane) ?? false)
}
```

Run `bun test test/unstarted.test.ts test/tick.test.ts`. Expect all to pass. Run `bunx tsc --noEmit`.
Expect no errors.

### Step 2.3: commit

```
git add src/lib/unstarted.ts test/unstarted.test.ts
git commit -m "fix: add holdsPane and drop former pane ids with the pane

Claude-Session: https://claude.ai/code/session_01F3fK9hFDWkrq6nNwwXD6Yy"
```

---

## Task 3 — `pipelinePanes` includes former ids (`src/lib/tiers.ts`)

### Step 3.1: failing test (`test/tiers.test.ts`)

In the test `'the pipeline panes are the orchestrator and every task pane, live or last'` (about line
53), change the title to:

```ts
test('the pipeline panes are the orchestrator and every task pane, live, last or former', () => {
```

Replace its `run.tasks = [...]` assignment and the `expect` after it with:

```ts
  run.tasks = [
    task({ task_id: 't1', pane_id: 'w7:p1' }),
    task({ task_id: 't2', pane_id: null, last_pane_id: 'w3:p1' }),
    task({ task_id: 't3', pane_id: 'w5:p2', former_pane_ids: ['w3:p2', 'w4:p2'] }),
  ]
  expect([...pipelinePanes(run)].sort()).toEqual(['w1:p1', 'w3:p1', 'w3:p2', 'w4:p2', 'w5:p2', 'w7:p1'])
```

Run `bun test test/tiers.test.ts`. Expect this test to fail, because `w3:p2` and `w4:p2` are missing.

### Step 3.2: implement (`src/lib/tiers.ts`)

Replace the doc comment and body of `pipelinePanes` (about lines 61-75) with:

```ts
/**
 * Every pane the pipeline put an agent in, including the ids a moved pane had
 * before herdr renamed it. A guard, not authentication: an orchestrator rebound
 * by `claim` still carries an id this set no longer holds. The prompts forbid
 * lowering; this only stops an agent that ignores them from its own pane.
 */
export function pipelinePanes(run: Run): Set<string> {
  const panes = new Set<string>()
  if (run.orchestrator_pane !== null) panes.add(run.orchestrator_pane)
  for (const task of run.tasks) {
    if (task.pane_id !== null) panes.add(task.pane_id)
    if (task.last_pane_id !== undefined) panes.add(task.last_pane_id)
    for (const pane of task.former_pane_ids ?? []) panes.add(pane)
  }
  return panes
}
```

Run `bun test test/tiers.test.ts`. Expect all to pass.

### Step 3.3: commit

```
git add src/lib/tiers.ts test/tiers.test.ts
git commit -m "fix: refuse a tier lowering from a moved worker's former pane id

Claude-Session: https://claude.ai/code/session_01F3fK9hFDWkrq6nNwwXD6Yy"
```

---

## Task 4 — `resume` refuses a former id (`src/cli.ts`)

### Step 4.1: failing tests (`test/cli-commands.test.ts`)

Insert directly after the test `'a human pane that carries a finished task\'s old pane id may resume
the run'` (about line 358):

```ts
test('a moved worker is refused a resume from the id its pane had before the move, as from its current one — herdr-pl-3', async () => {
  const run = abortableRun()
  run.tasks[0]!.pane_id = 'w8:p1'
  run.tasks[0]!.former_pane_ids = ['w3:p1']
  await saveRun(dir, run)
  await cmdAbort(ctx(), { runId: run.run_id })
  const fromCurrent = await cmdResume(ctx(), { runId: run.run_id, callerPane: 'w8:p1' })
  const fromFormer = await cmdResume(ctx(), { runId: run.run_id, callerPane: 'w3:p1' })
  expect(fromCurrent.ok).toBe(false)
  expect(fromFormer.ok).toBe(false)
  expect(fromFormer.text).toBe("w3:p1 is t1's worker pane: a run is resumed by the orchestrator or the human, never by " +
    'its workers. Stop, and end your turn')
  expect(fromFormer.text).toBe(fromCurrent.text.replace('w8:p1', 'w3:p1'))
})

test('a finished task\'s former pane id does not refuse a resume — herdr-pl-3', async () => {
  const run = abortableRun()
  run.tasks[3]!.former_pane_ids = ['w9:p1']
  await saveRun(dir, run)
  await cmdAbort(ctx(), { runId: run.run_id })
  expect((await cmdResume(ctx(), { runId: run.run_id, callerPane: 'w9:p1' })).ok).toBe(true)
})

test('once a moved worker\'s pane is gone, its former id no longer refuses the human\'s resume — herdr-pl-3', async () => {
  const run = abortableRun()
  run.tasks[0]!.pane_id = 'w8:p1'
  run.tasks[0]!.former_pane_ids = ['w3:p1']
  await saveRun(dir, run)
  await cmdAbort(ctx(), { runId: run.run_id })
  const aborted = (await listRuns(dir, 'personal'))[0]!
  applyEvents([aborted], [{ kind: 'pane.closed', session: 'personal', at: 2, pane_id: 'w8:p1' }], 'personal', new Set())
  expect(aborted.tasks[0]?.pane_id).toBeNull()
  expect(aborted.tasks[0]?.former_pane_ids).toBeUndefined()
  await saveRun(dir, aborted)
  expect((await cmdResume(ctx(), { runId: run.run_id, callerPane: 'w3:p1' })).ok).toBe(true)
})
```

`abortableRun()` gives t1 (`implement`, `w3:p1`) as `tasks[0]` and t4 (`done`, `w6:p1`) as
`tasks[3]`. `listRuns`, `applyEvents` and `saveRun` are already imported in this file.

Run `bun test test/cli-commands.test.ts`. Expect the first new test to fail, because `fromFormer.ok`
is `true`. The other two pass. The second guards the phase filter. The third's `resume` would
succeed even without Task 2, because `resume` still matches on `pane_id` alone until Step 4.2 and
that `pane_id` is now null. Its `toBeUndefined()` assertion is what depends on Task 2. After Step
4.2, the whole test is the guard that a released pane's former id no longer refuses the human.

### Step 4.2: implement (`src/cli.ts`)

Add `holdsPane` to the import from `'./lib/unstarted'` (about lines 70-73):

```ts
import {
  bindWorkerPane, briefCommand, dispatchSequence, dispatchWorkerCommand, freshLadder, holdsPane, shellQuoted,
  startWorkerCommand, unbriefedWorker,
} from './lib/unstarted'
```

In `async function resume(` (about line 3110), replace these lines:

```ts
  // A worker refused on an aborted run is shown the resume command, and the abort is not its to undo.
  // Only a pane a task holds now: herdr reuses ids, so a human's pane can carry a finished task's old one.
  const worker = input.callerPane == null ? undefined
    : run.tasks.find((task) => task.pane_id === input.callerPane && !taskPhaseIsTerminal(task.phase))
  if (worker !== undefined) {
    return fail(`${input.callerPane} is ${worker.task_id}'s worker pane: a run is resumed by the orchestrator or the ` +
      'human, never by its workers. Stop, and end your turn')
  }
```

with:

```ts
  // A worker refused on an aborted run is shown the resume command, and the abort is not its to undo.
  // Only a pane a task holds now, by its current id or one a move renamed: herdr reuses ids, so a
  // human's pane can carry a finished task's old one, or a dead pane's `last_pane_id`.
  const caller = input.callerPane ?? null
  const worker = caller === null ? undefined
    : run.tasks.find((task) => holdsPane(task, caller) && !taskPhaseIsTerminal(task.phase))
  if (worker !== undefined) {
    return fail(`${caller} is ${worker.task_id}'s worker pane: a run is resumed by the orchestrator or the ` +
      'human, never by its workers. Stop, and end your turn')
  }
```

Run `bun test test/cli-commands.test.ts`. Expect all to pass. Run `bunx tsc --noEmit`. Expect no
errors.

### Step 4.3: commit

```
git add src/cli.ts test/cli-commands.test.ts
git commit -m "fix: refuse a resume from a moved worker's former pane id

Claude-Session: https://claude.ai/code/session_01F3fK9hFDWkrq6nNwwXD6Yy"
```

---

## Task 5 — before-merge checks refuse a former id (`src/cli.ts` `paneRefusal`)

This test goes in `test/before-merge-cli.test.ts`, where the existing `paneRefusal` tests and their
fixtures are. The spec flags this as a deliberate deviation from the bead's acceptance, which names
`cli-commands.test.ts`.

### Step 5.1: failing tests (`test/before-merge-cli.test.ts`)

Insert directly after the test `'a pane a finished task or an undriven run still records is no
worker\'s: herdr reuses workspace ids'` (about line 164):

```ts
test('a moved worker is refused hold and confirm from the id its pane had before the move, as from its current one — herdr-pl-3', async () => {
  const run = await seeded(perTaskRun([
    heldTask({ pane_id: 'w5:p2', former_pane_ids: ['w3:p2'], before_merge: [checkOf('c1')] }),
  ]))
  const heldFromCurrent = await hold(run, ['no ghost'], 't1', reads(), 'w5:p2')
  const heldFromFormer = await hold(run, ['no ghost'], 't1', reads(), 'w3:p2')
  expect(heldFromCurrent.ok).toBe(false)
  expect(heldFromFormer.ok).toBe(false)
  expect(heldFromFormer.text).toContain("w3:p2 is t1's worker pane")
  expect(heldFromFormer.text).toBe(heldFromCurrent.text.replace('w5:p2', 'w3:p2'))

  const ruledFromCurrent = await confirm(run, 'c1', { pane: 'w5:p2' })
  const ruledFromFormer = await confirm(run, 'c1', { pane: 'w3:p2' })
  expect(ruledFromCurrent.ok).toBe(false)
  expect(ruledFromFormer.ok).toBe(false)
  expect(ruledFromFormer.text).toContain("w3:p2 is t1's worker pane")
  expect(ruledFromFormer.text).toBe(ruledFromCurrent.text.replace('w5:p2', 'w3:p2'))

  const after = taskOf(await saved(run))
  expect(after.before_merge?.map((c) => c.id)).toEqual(['c1'])
  expect(after.before_merge?.[0]?.resolutions).toEqual([])
})

test('a finished task\'s former pane id is no worker\'s — herdr-pl-3', async () => {
  const finished = heldTask({
    task_id: 't2', branch: 'feat/old', bead: 'hp-2', phase: 'done', merged_at_ms: 1,
    pane_id: null, former_pane_ids: ['w3:p2'],
  })
  const run = await seeded(perTaskRun([heldTask(), finished]))
  const held = await hold(run, ['no ghost'], 't1', reads(), 'w3:p2')
  expect(held.ok, held.text).toBe(true)
})
```

Run `bun test test/before-merge-cli.test.ts`. Expect the first new test to fail, because
`heldFromFormer.ok` is `true`. The second passes; it guards the phase filter.

### Step 5.2: implement (`src/cli.ts`)

In `async function paneRefusal(` (about line 2395), replace:

```ts
    const worker = run.tasks.find((t) => t.pane_id === pane && !taskPhaseIsTerminal(t.phase))
```

with:

```ts
    const worker = run.tasks.find((t) => holdsPane(t, pane) && !taskPhaseIsTerminal(t.phase))
```

`pane` is narrowed to `string` by the `if (pane === null) return ...` line above it. If `tsc` reports
it as `string | null` inside the callback, add `const caller: string = pane` directly after that
`if` line and use `caller` in the callback and in the message instead.

Run `bun test test/before-merge-cli.test.ts`. Expect all to pass. Run `bunx tsc --noEmit`. Expect no
errors.

### Step 5.3: commit

```
git add src/cli.ts test/before-merge-cli.test.ts
git commit -m "fix: refuse a before-merge check from a moved worker's former pane id

Claude-Session: https://claude.ai/code/session_01F3fK9hFDWkrq6nNwwXD6Yy"
```

---

## Task 6 — `forget` drops the former ids (`src/cli.ts`)

### Step 6.1: failing test (`test/cli-commands.test.ts`)

Insert directly after the test `'forget unbinds a workspace from its task'` (about line 431, ending
with `expect((await listRuns(dir, 'personal'))[0]?.tasks[0]?.workspace_id).toBeNull()`):

```ts
test('forget drops a moved pane\'s former ids with the pane — herdr-pl-3', async () => {
  const run = runWithTasks([{
    task_id: 't1', phase: 'implement', workspace_id: 'w7', pane_id: 'w5:p2', former_pane_ids: ['w7:p1'],
  }])
  await saveRun(dir, run)
  expect((await cmdForget(ctx(), { workspaceId: 'w7' })).ok).toBe(true)
  const task = (await listRuns(dir, 'personal'))[0]?.tasks[0]
  expect(task?.pane_id).toBeNull()
  expect(task?.former_pane_ids).toBeUndefined()
})
```

Run `bun test test/cli-commands.test.ts`. Expect this test to fail, because `former_pane_ids` is
still `['w7:p1']`.

### Step 6.2: implement (`src/cli.ts`)

In `async function forget(` (about line 3192), replace:

```ts
  task.workspace_id = null
  task.pane_id = null
```

with:

```ts
  task.workspace_id = null
  task.pane_id = null
  delete task.former_pane_ids
```

Run `bun test test/cli-commands.test.ts`. Expect all to pass.

### Step 6.3: commit

```
git add src/cli.ts test/cli-commands.test.ts
git commit -m "fix: forget drops a moved pane's former ids

Claude-Session: https://claude.ai/code/session_01F3fK9hFDWkrq6nNwwXD6Yy"
```

---

## Task 7 — whole-suite verification

### Step 7.1

Run `bunx tsc --noEmit`. Expect no output and exit 0.

Run `bun test`. Expect 0 failures. If a test outside the files above fails, read its assertion
and decide whether this change caused it. A test that builds a `Task` and compares it whole with
`toEqual` is the likely kind. If this change caused it and the failing test is in one of the files on
this plan's `FILES:` lines, fix it there. If it is in any other file, stop and report it with its
output, without editing that file: it is outside this task's file lock, and the orchestrator raises
it with `hpipe decide`. If it is unrelated, report it with its output and do not fix it here.
Never use `git stash`, because the stash is shared with other worktrees.

### Step 7.2

Run `git status --short`. Expect a clean tree: every change is committed. `git log --oneline
8514924..HEAD` lists the six `fix:` commits above, after the research, spec, review and plan doc
commits. Do not push.

## Live check (not part of this plan's steps)

The spec's live runbook needs the change installed: move a running worker's pane across workspaces
with `herdr pane move`, see the ledger hold the new `pane_id` and the old id in `former_pane_ids`,
then run `hpipe resume <run>` from that worker's pane and see it refused. The orchestrator or the
human runs it after merge. It is not a step here.
