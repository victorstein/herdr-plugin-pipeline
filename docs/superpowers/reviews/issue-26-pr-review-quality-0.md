# PR #52 — stage 2, code quality

Branch `fix/26-verdict-overwrite`, 8 commits, `src/lib/verdict-path.ts` new plus `src/cli.ts`,
`src/lib/types.ts`, `src/supervisor/deliver.ts`, `src/supervisor/tasks.ts`, `prompts/escalate.md`,
six test files and `test/integration/smoke.md`.

Gates verified in this worktree: `bun test` → **527 pass / 0 fail**, 1326 expect() calls across 35
files. `bun run typecheck` → **exit 0**. Both match what the brief predicted.

Scope: how the change is written. Intent is settled by stage 1 and I did not re-litigate it.

---

## MAJOR

### 1. `verdictBase` is named for verdicts, used for artifacts, and its comment claims a uniqueness that is false

`src/lib/verdict-path.ts:17-20`

```ts
/** The ONE base a repo-relative verdict path resolves against. */
export function verdictBase(run: Run, task: Task | null): string {
  return task?.checkout_path ?? run.repo_root
}
```

Three problems, all in the same four lines.

**It is not the one base.** `src/supervisor/tasks.ts:109` still spells the identical expression:

```ts
function taskArtifactPath(run: Run, task: Task, slot: 'research' | 'spec' | 'plan'): string {
  const rel = task.artifacts[slot]
  if (rel === null) return ''
  return join(task.checkout_path ?? run.repo_root, rel)   // tasks.ts:109
}
```

That site predates the PR, so the change did not *add* the duplicate — but the PR is what introduces
a helper whose doc comment asserts the duplicate does not exist. The PR correctly folded in
`deliver.ts`'s copy (the old `const base = task?.checkout_path ?? run.repo_root`); it stopped one
site short and then wrote the stronger claim anyway. A reader who takes the comment at face value
and edits `verdictBase` will silently desynchronise task artifact resolution from task verdict
resolution.

Compare how this repo phrases a real single-address claim — `src/lib/ledger.ts:134-137` says "one
address, so the next caller reading a phase off disk finds them instead of writing a fourth
spelling," and it is true when written. The bar here is factual, not rhetorical.

**The name is wrong for half its callers.** `absoluteArtifactPath` now routes *every* artifact path
through it, not just verdicts:

```ts
// src/supervisor/deliver.ts:118-122
export function absoluteArtifactPath(run: Run, task: Task | null): string | null {
  const rel = artifactPathFor(run, task)
  if (rel === null) return null
  return join(verdictBase(run, task), rel)
}
```

`artifactPathFor` returns `task.artifacts[row.artifact]` for the `research`/`spec`/`plan` rows
(`deliver.ts:109`) — those are not verdicts, and they are the majority of what
`absoluteArtifactPath` resolves in practice. The pre-PR code had no name for this, so nothing was
wrong; naming it `verdictBase` is what makes it wrong. The existing docstring one line above
(`deliver.ts:117`, "Task artifacts live in the worker's linked worktree; run artifacts in the main
checkout") describes the general rule accurately and is now contradicted by the callee's name.

**Consequence for the module's own framing.** The file leads with three "The ONE …" docstrings
(`:7`, `:12`, `:17`). Two of them are true and verified — `verdictFilename` is the only template
that spells a verdict filename (`grep '\.md\`' src/` shows the other four hits are the research /
spec / plan / agent-file stems in `cli.ts` and `worker-prompt.ts`), and `verdictPrefix` is the only
place `issue-${…}` is built for a review (`cli.ts:215` builds a different, date-prefixed artifact
stem). The third being false costs the other two their credibility.

**Fix inline, no judgment call:** rename to `artifactBase`, reword the docstring to the rule it
actually holds ("task artifacts resolve against the worker's checkout, run artifacts against the
main checkout"), and point `tasks.ts:109` at it. That makes the claim true and the name honest in
one edit. If the run-vs-task framing is wanted verbatim, `types.ts:77` already states it.

---

## MINOR

### 2. A new comment cites a line this PR itself moved

`test/prompts.test.ts:152`

```ts
// `cmdRewind` clears the whole counter map (`src/cli.ts:353`), not one phase's.
```

`src/cli.ts:353` is `at: Date.now(), task_id: task.task_id, from: task.phase, to: input.phase,` —
an argument line inside the abandoned-decision `history.push`. The counter clear is at
`src/cli.ts:360` (`task.passes = {}`) and `src/cli.ts:370` (`run.passes = {}`). The offset is
exactly the six lines this PR inserted above it at `cli.ts:324-329` (the `let reserved` block and
its comment), so the citation was written against the pre-PR file and not re-checked afterwards.

`file.ts:N` citations are a heavy and deliberate convention here — 25+ of them across `src/` and
`test/`, and the PR's own `verdict-path.ts:24` pointer at `machine.ts:5` is correct. This one is
the outlier. Retarget it at `:360`, or cite both sites since the sentence is about "the whole map"
on either record.

### 3. First `console.*` in `src/lib/`

`src/lib/verdict-path.ts:82`

```ts
console.error(
  `[pipeline] ${prefix}: ${PROBE_LIMIT} verdict paths from ${phase}-${seq} are taken — ` +
  `falling back to ${chosen}, which may already hold a review`,
)
```

`grep -rn 'console\.' src/lib/` returns exactly this one line. Across the other 21 modules in
`src/lib/` — including `ledger.ts` and `predicates.ts`, which both do real filesystem I/O, so this
is not a purity rule about side effects — there are zero. Every other `console.*` in the tree is in
`src/supervisor/` (main.ts ×10, tasks.ts ×1), `src/cli.ts` (×4) or `src/hooks/` (×1). `plugin-dev.md`
calls `src/lib/` "the pure core" and `src/supervisor/` "the driver"; this is the driver's log line
placed in the core.

It also mislabels itself on one of its two call paths. `reserveVerdict` runs from `hpipe rewind`
(`cli.ts:366`, `:381`) as well as from the supervisor tick, and the CLI routes everything it says
through `ok()`/`fail()` and the single `console.log(out.text)` at `cli.ts:683`. A `[pipeline]`-prefixed
stderr line from a one-shot CLI invocation reads as supervisor output that isn't.

Cheapest fix that keeps the diagnostic: have `reserveVerdict` signal exhaustion in its return (or
take an injected reporter, as `TaskDeps` already does for the supervisor's other side effects) and
let the two call sites decide how to say it. Simplest fix: move the `console.error` to the two call
sites.

### 4. A superseded test name left in place while its neighbours were renamed

`test/deliver.test.ts:149`

```ts
test('a review path is keyed by the phase counter, so a re-review is a new file', () => {
  const run = mkRun()
  run.phase = 'branch-review'
  const first = artifactPathFor(run, null)
  run.passes['branch-review'] = 1
  expect(artifactPathFor(run, null)).not.toBe(first)
})
```

After this PR a review path is keyed by `verdict_seq`, not by the pass counter — that is the change.
This test leaves `verdict_seq` unset, so it exercises only the `??` fallback at `deliver.ts:113-114`,
which the PR's own docstring calls "the pre-#26 derivation … reached only by a record that entered
this change mid-review." The test is still worth keeping (pinning the legacy branch byte-for-byte is
exactly what a mid-review record needs), but its name now states the superseded rule as the general
one.

The PR did rename the two tests immediately below it — `:157` became "a recorded verdict path is
returned for the key verdict_seq names" and `:165` is new — so the omission is inconsistent within
the same six lines of diff. Rename to something like "a record with no verdict_seq still keys on the
phase counter".

### 5. `VerdictRecord.artifacts` re-spells a named type that already exists

`src/lib/verdict-path.ts:26-29`

```ts
interface VerdictRecord {
  artifacts: { verdicts: Record<string, string> }
  verdict_seq?: Record<string, number | undefined>
}
```

`src/lib/types.ts:105-107` already exports exactly that shape:

```ts
export interface RunArtifacts {
  verdicts: Record<string, string>
}
```

`artifacts: RunArtifacts` compiles for both records (`Task['artifacts']` is structurally wider and
assigns fine), so the inline object literal is a second spelling of an existing declaration. The
name is run-flavoured, which is a fair reason to hesitate — but then the honest fix is to widen the
name in `types.ts`, not to re-declare the shape.

On the brief's specific question — whether `VerdictRecord` *matches* `HasPasses` (`machine.ts:5`) or
merely nearly matches — the answer is that it matches where it counts. Both are module-private, both
sit immediately above their first user, and the `verdict_seq?` optionality faithfully mirrors
`types.ts:96` (`verdict_seq?: Partial<Record<TaskPhase, number>>`) the same way `HasPasses`'s
required `passes` mirrors `types.ts:90`. The optional field is also consistent with the existing
`stall?: StallState` on both records, which is how this repo already adds a field without a
`schema_version` bump — and `plugin-dev.md:50-51` is explicit that a `schema_version` change is a
change to runs already on disk. That call is right.

The one asymmetry worth naming, and it is stylistic: `HasPasses` carries no docstring, while
`VerdictRecord` carries a four-line one whose payload is "the same reason `HasPasses` exists." If
the reason is worth stating, `machine.ts:5` is where it belongs.

### 6. The same new import, placed by two different rules across three files

- `src/cli.ts:20` — `./lib/verdict-path` between `./lib/status` and `./lib/worker-prompt`. Sorted.
- `src/supervisor/tasks.ts:11` — after `../lib/worker-prompt`, breaking an otherwise sorted `../lib`
  block (`decisions, gating, gh, machine, phases, predicates, render, worker-prompt`) that ends with
  the type-only `../lib/types`.
- `src/supervisor/deliver.ts:7-9` — between `../lib/predicates` and `../lib/render`, breaking the
  sorted run `gh → herdr → machine → phases → predicates → render`.

No linter enforces this, and `deliver.ts` was already unsorted further down (`badges` after
`render`), so this is the smallest finding in the review. It is still three insertions of one import
done two ways in one diff. `cli.ts` has it right; match it.

### 7. Two assertions in the new test file restate a one-liner rather than testing behaviour

`test/verdict-path.test.ts:30` and `:41-46`

```ts
expect(REVIEWS_DIR).toBe('docs/superpowers/reviews')
...
expect(verdictBase(run, mkTask({ checkout_path: '/w' }))).toBe('/w')
expect(verdictBase(run, mkTask({ checkout_path: null }))).toBe('/r')
```

Both read back the literal body of a one-line function. Neither would catch a real regression that
something else does not already catch: `verdictBase` is covered end-to-end by
`test/tasks.test.ts:481-484`, which asserts the full
`/r/.worktrees/feat-x/docs/superpowers/reviews/issue-1-spec-review-0.md`, and `REVIEWS_DIR` has a
genuine contract — `prompts/implement.md:15`, `prompts/plan.md:18` and `prompts/spec.md:21` all
hardcode `docs/superpowers/reviews/` in prose, and `adoptableArtifacts` filters on it at
`deliver.ts:187` — but this assertion tests none of that. `test/prompts.test.ts` shows the shape
that would: read the prompt file and assert against it.

The sibling assertions in the same file are not in this category and should stay.
`verdictFilename('issue-26', 'spec-review', 2)` at `:31-32` pins the exact wire format that
`artifactPathFor`'s legacy `??` branch must keep reproducing for a record upgraded mid-review, which
is real.

---

## What holds up

Stated plainly because the brief asks for an honest ranking, and several of these were the things
most likely to have gone wrong.

**The comment bar is met, in the harder direction.** The deleted comment in `deliver.ts` justified
the prefix filter with "nothing ever populates `artifacts.verdicts` — `artifactPathFor` reads it and
no writer exists." This PR creates that writer, which invalidates the reason. The replacement at
`deliver.ts:102-104` does not paper over it — it supplies the new reason ("it runs for artifact rows
only, so the filter is what keeps a review out of an artifact slot"). Updating the *justification*
of an unchanged line is the failure mode this repo's convention exists to prevent, and it did not
happen here.

**`cli.ts:324-327` states an invariant that is actually true.** "`advanceTask` returns null for a row
whose verdict is not fresh, so the task loop never reaches `promptForTaskPhase`" — confirmed at
`tasks.ts:178-179` (`if (!advanceTask(…)) continue; if (task.phase === cameFrom) continue`). The
comment is the load-bearing justification for reserving in `cmdRewind` at all, and it checks out.

**"NOT idempotent" is a real constraint and the call sites honour it.** I traced every path that can
reach a prompt render. `evaluateRun` → `promptForRunPhase` (`deliver.ts:249`) and
`main.ts:215-217` cannot both fire for one entry, because `runPhaseBefore` is captured at
`main.ts:184`, *after* `evaluateRun` has already returned. `stall.ts:371` enters `escalated`, which
is not a verdict row and renders no prompt. Delivery retry (`main.ts:248-261`) operates on
already-rendered text and never re-renders. No double-reserve path exists.

**Duplication, checked by grep rather than by the diff.** One spelling of the verdict filename
(`verdict-path.ts:9`), one of the prefix (`:14`), one `REVIEWS_DIR` constant with `deliver.ts:187`
importing it rather than keeping the old local copy. The old local `const REVIEWS_DIR` is gone, not
shadowed. Every export in the new module has a real consumer — no dead exports.

**Test design.** The guard tests are negative-space tests that would actually fail if the guard were
deleted: `test/deliver.test.ts:404-410` and `test/tasks.test.ts:490-496` both assert
`verdict_seq` is `undefined` after a non-review row renders, which only holds while the
`signal === 'verdict'` check is in place. `test/cli-commands.test.ts:647-651` explicitly seeds
`verdict_seq: { 'spec-review': 2 }` rather than leaving it absent, with a comment saying why — an
empty fixture would have satisfied `toBeUndefined()` while an implementation that cleared
`verdict_seq` alongside `passes` destroyed the no-regression property. That is the distinction
between a test that is present and a test that is designed.
`test/verdict-path.test.ts:120-135` likewise fails under the obvious wrong implementation (restarting
the walk at ordinal 0 each call). The new file's `mkTask`/`mkRun` locals duplicate nothing —
`test/helpers/` exposes only `tempDir`, `cleanupFixtures`, `repoWithWorktree`, `commitIn` and `git`,
and all ten test files that need a task fixture define their own. The file uses the shared
`tempDir` + `afterEach(cleanupFixtures)` where it needs real `existsSync` behaviour, which is the
right call.

The `[pipeline] issue-26: 64 verdict paths …` line in the `bun test` output is the intended
diagnostic from `test/verdict-path.test.ts:152-167`, not a failure, and `test/hook.test.ts` already
sets the precedent for a test that prints.

---

## Summary

| Rank | Finding | Location |
| --- | --- | --- |
| MAJOR | `verdictBase` misnamed, used for non-verdict artifact paths, "The ONE" claim false | `src/lib/verdict-path.ts:17`, `src/supervisor/deliver.ts:121`, `src/supervisor/tasks.ts:109` |
| MINOR | Comment cites `cli.ts:353`; the clear is at `:360`/`:370` | `test/prompts.test.ts:152` |
| MINOR | First `console.*` in `src/lib/`; `[pipeline]` prefix wrong on the CLI path | `src/lib/verdict-path.ts:82` |
| MINOR | Test name states the superseded keying rule | `test/deliver.test.ts:149` |
| MINOR | `VerdictRecord.artifacts` re-spells `RunArtifacts` | `src/lib/verdict-path.ts:27`, `src/lib/types.ts:105` |
| MINOR | One import, three sites, two placement rules | `src/supervisor/tasks.ts:11`, `src/supervisor/deliver.ts:7` |
| MINOR | Two assertions restate a one-line implementation | `test/verdict-path.test.ts:30`, `:41-46` |

No BLOCKER. The MAJOR is a rename plus a comment correction plus redirecting one existing call —
it reverses no decision, changes no scope, and needs no judgment the human has to supply.

VERDICT: CLEAR
BLOCKERS: 0
MAJORS: 1
