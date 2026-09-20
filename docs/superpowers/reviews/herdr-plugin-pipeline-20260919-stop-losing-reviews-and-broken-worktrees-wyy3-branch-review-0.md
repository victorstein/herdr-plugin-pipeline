# Branch review — "stop losing reviews and broken worktrees"

Whole-branch adversarial review of `main` at `282f95e` (release 1.3.0), covering the two tasks merged
in this run:

- **PR #52** / issue **#26** — `f406173`, *"assign each review its own verdict path instead of deriving one"*.
- **PR #54** / issue **#16** — `7b22d07`, *"bootstrap fresh worktrees from a script the repo declares"*,
  rebased onto `f406173` before merge.

Both issues carry orchestrator rulings appended mid-run (#26's **Ruling — 2026-09-19** plus the
recorded live reproduction; #16's **Ownership ruling — `src/cli.ts`, 2026-09-19**); those govern over
the original issue text and are what this review checked the code against.

## Measured, not assumed

CI here is a PR-title lint only (#35), so every number below was run locally for this review.

| Tree | `bun test` | `bun run typecheck` |
|---|---|---|
| `282f95e` (`main`, this review's subject) | `551 pass, 0 fail, 1364 expect() calls, Ran 551 tests across 36 files. [8.91s]` | `$ tsc --noEmit`, exit 0, no output |
| `f406173` (#52 as merged) | `527 pass, 0 fail, 1326 expect() calls, Ran 527 tests across 35 files. [8.84s]` | `$ tsc --noEmit`, exit 0 |
| `f406173^` = `be18175` (baseline before the branch) | `503 pass, 0 fail, 1265 expect() calls, Ran 503 tests across 34 files. [8.73s]` | — |

Working tree clean (`git status --porcelain` empty) before and after; the two throwaway worktrees used
for the historical runs were removed and `git worktree prune` run.

**Both PR bodies quote their own figures accurately.** PR #52 claims `527 pass / 1326 expect / 35 files`
with a `503 pass / 1265 expect` baseline — both reproduce byte-for-byte. PR #54 claims
`551 pass / 0 fail / 1364 expect / 36 files` — that is exactly what `main` measures today. Given that
two earlier PRs in this project misreported their own numbers, this was checked specifically, and
neither PR did.

## 1. The `src/cli.ts` seam

The rebase resolution is **correct and complete**.

Both imports are present and both are used:

- `src/cli.ts:4` — `import { bootstrapLine, repoBootstrap } from './lib/bootstrap'`, consumed at
  `src/cli.ts:263` (`const bootLine = bootstrapLine(repoBootstrap(run.repo_root))`).
- `src/cli.ts:21` — `import { reserveVerdict } from './lib/verdict-path'`, consumed at
  `src/cli.ts:372` and `:387` inside `cmdRewind`.
- `src/cli.ts:14` — `runRow` was added to the `./lib/phases` import by #52 and is used at `:386`.

No duplicate or shadowed symbol: the only other `node:fs` import in the file is `existsSync`
(`src/cli.ts:2`), and `src/lib/bootstrap.ts` uses `statSync` internally rather than re-exporting
anything `cli.ts` already holds. `tsc --noEmit` exits 0, which would have caught a redeclaration.

The two functions are disjoint and both intact, exactly as the #16 ruling's condition 2 required:

- **#16's edit is confined to `cmdTask`.** `git show 7b22d07 -- src/cli.ts` is three hunks: the import
  at `:4`, `bootLine` at `:260-263`, and the two `return ok(...)` strings at `:267` and `:276`.
  `cmdRewind` is not touched by that diff, and `grep -n "bootstrap" src/cli.ts` finds nothing inside
  `cmdRewind`.
- **#26's edit is confined to `cmdRewind`.** `git show f406173 -- src/cli.ts` touches only the imports
  and `cmdRewind`'s body (`:330`, `:371-373`, `:386-388`, `:391-394`).

Header-block behaviour matches the spec: `cmdTask` now emits three orchestrator-only header lines on
both its return paths — the queued return at `src/cli.ts:267` (`task_id:` / `files:` / `bootstrap:` /
`queued: waiting on …`) and the dispatched return at `:276` (`task_id:` / `files:` / `bootstrap:` /
blank / brief). `prompts/dispatch.md:26-30` was updated in the same PR to say "the **three** header
lines", and `test/prompts.test.ts:181` pins that the word "two header" is gone. The blank-line split
that `prompts/dispatch.md` relies on is unmoved, because `bootstrapLine` is contractually one line
(`src/lib/bootstrap.ts:38-44`, pinned by `test/bootstrap.test.ts:62-70`).

I also rendered the worker brief for all three bootstrap states against the real
`renderWorkerPrompt`. In every case the brief's first blank line is still index 1, immediately after
the `# fix/1 — issue #99` heading, which is the invariant `prompts/dispatch.md:30-33` documents for
`hpipe brief`:

```
--- none:     firstBlankIndex=1 line0="# fix/1 — issue #99"   bootstrapNoteAtLine=-1
--- ready:    firstBlankIndex=1 line0="# fix/1 — issue #99"   bootstrapNoteAtLine=15
--- not-exec: firstBlankIndex=1 line0="# fix/1 — issue #99"   bootstrapNoteAtLine=15
```

## 2. #26's core claim, exercised on the paths that broke it

All three sub-claims hold. I drove them through the real modules (`src/cli.ts`, `src/supervisor/tasks.ts`,
`src/supervisor/deliver.ts`, `src/lib/ledger.ts`) against a real temp checkout and a real on-disk
ledger, with `deps.verdictFor` wired to the same `isFresh`/`isSettled`/`parseVerdict` chain the
supervisor uses at `src/supervisor/main.ts:193-198` — not fakes. Transcript:

```
A phase=spec-review reserved={"spec-review-0":"docs/superpowers/reviews/issue-99-spec-review-0.md"} seq={"spec-review":1}
B phase=spec passes={"spec-review":1}
B2 phase=spec-review path=docs/superpowers/reviews/issue-99-spec-review-1.md
   verdicts={"spec-review-0":"…-0.md","spec-review-1":"…-1.md"}
B3 clobber? no
C decide ok=true opened decision d1 on t1; task blocked-on-decision
C answer ok=true
C phase=spec-review pathBefore=…-spec-review-1.md pathAfter=…-spec-review-1.md moved=false
C seq={"spec-review":2}
C advanced-to=plan
D rewind ok=true :: rewound t1 to spec-review; counters cleared; next verdict → docs/superpowers/reviews/issue-99-spec-review-2.md
D path=docs/superpowers/reviews/issue-99-spec-review-2.md passes={}
D existsAlready=false
D advanced-to=plan
FILES: issue-99-spec-review-0.md, issue-99-spec-review-1.md, issue-99-spec-review-2.md
```

**(a) Something now actually writes `artifacts.verdicts`.** The only writer is
`src/lib/verdict-path.ts:99` (`record.artifacts.verdicts[verdictKey(phase, seq)] = chosen`), reached
from exactly three guarded call sites, all on `signal === 'verdict'`:
`src/supervisor/tasks.ts:54` (task prompt render), `src/supervisor/deliver.ts:259` (run prompt render),
and `src/cli.ts:372`/`:387` (`cmdRewind`, the one commission that renders no prompt). Line A above is
the field being populated on a task whose `artifacts.verdicts` started `{}` — the exact state the
issue's live observation recorded as proof nothing wrote it.

**(b) The reader is a key lookup, not a scan or a "lowest free"/"highest recorded" choice.**
`verdictFor` (`src/lib/verdict-path.ts:41-45`) is `record.artifacts.verdicts[`${phase}-${seq-1}`] ?? null`
— one dictionary index, no `Object.keys`, no sort, no filesystem access. The filesystem probe lives
only in `reserveVerdict` (`src/lib/verdict-path.ts:81-86`) and picks a *filename*, never a key, so a
name freed on disk (the `git mv` preservation this repo has applied four times) can change what a
future reservation chooses and can never change what an already-issued key resolves to. The reserver
and the reader share one spelling through `verdictFilename`/`verdictPrefix`/`artifactBase`
(`src/lib/verdict-path.ts:8-24`) — the divergence that was a BLOCKER in the per-task review is
structurally closed, and `grep -rn "docs/superpowers/reviews" src/` returns exactly one definition
(`src/lib/verdict-path.ts:5`) plus one import (`src/supervisor/deliver.ts:9`).

**(c) A resume does not allocate a new path — including on the concrete failure the issue recorded.**
Line C is that path run end to end: worker calls `hpipe decide` from `spec-review`, orchestrator
answers, `deliverPendingAnswers` re-enters the phase at `src/supervisor/tasks.ts:352`. `verdict_seq`
stays at `2`, `artifacts.verdicts` is unchanged, and `verdictFor` returns the same file before and
after. The deliberate absence of a prompt render there is recorded in a *why* comment at
`src/supervisor/tasks.ts:349-351`, so the obvious later "fix" for a stuck row cannot silently restore
the bug, and `test/decide.test.ts:466-501` pins it.

I then checked the second half of the question — whether the row can still **move** after that
re-entry, which is what the issue's live reproduction says it could not. It can: line C's
`advanced-to=plan` is the row clearing after the worker writes the reserved path following the
resume. The mechanism the old bug depended on is gone, because the path the supervisor watches is now
this review's own file rather than an earlier pass's six-hour-old one. The residual is narrower and is
disclosed in PR #52's scope note: `enterTaskPhase` still re-stamps `phase_entered_at`
(`src/lib/machine.ts:94`), so a reviewer that had already finished writing its verdict *before* asking
its question leaves a file that `isFresh` (`src/lib/predicates.ts:16`) now rejects, and the row waits
for the 45-minute stall probe. That probe reads the path (`src/supervisor/stall.ts:203`, via
`absoluteArtifactPath`) rather than reserving a new one, so it names the correct file and says
"Nothing newer than this phase's start has appeared at: …" — a working recovery, just a slow one.
This is "removes the overwrite, not the wait", which is what the ruling asked for; the ruling's
invariant was path stability, and that holds.

**Exhaustive check that no commission is missed.** I enumerated every phase-entry site
(`grep -rn "enterTaskPhase(\|enterRunPhase(\|\.phase = " src/`) and traced which can land on a row with
`signal: 'verdict'`:

- `src/lib/machine.ts:118` (`onClear`), `:144` (`implement → pr-review-intent`) — both reached only
  through `advanceTasks`, which calls `promptForTaskPhase` at `src/supervisor/tasks.ts:183`. Reserved.
- `src/lib/machine.ts:124` (`onBlocker`) — every task review row's `onBlocker` is `spec`, `plan` or
  `implement` (`src/lib/phases.ts:97,102,112,115`), so this never lands on a verdict row and the
  `if (task.phase === cameFrom) continue` guard at `src/supervisor/tasks.ts:181` can never suppress a
  review commission.
- `src/lib/machine.ts:82` (`branch-review → branch-review`, the one self-looping review row,
  `src/lib/phases.ts:65`) — `evaluateRun` has no equivalent same-phase guard, so
  `promptForRunPhase` at `src/supervisor/deliver.ts:253` fires and reserves. Verified this asymmetry is
  load-bearing rather than accidental.
- `src/supervisor/tasks.ts:352` (resume) and `src/cli.ts:533` (`cmdResume` after `cmdAbort`) — the two
  non-commissions. Neither reserves; both keep the recorded path. Correct.
- `src/cli.ts:365`/`:375` (`cmdRewind`) — reserves explicitly.
- Everything else (`queued`, `blocked-on-decision`, `blocked-on-failure`, `failed`, `escalated`,
  `close`, `teardown`, `done`, `orphaned`, `implement`, `blocked-on-files`) targets a non-verdict row.

`verdict_seq` is written in one place only (`src/lib/verdict-path.ts:100-101`) and is deliberately
*not* cleared by `cmdRewind`, which clears `passes` alone (`src/cli.ts:367`, `:381`). That is what
makes monotonicity survive the original defect: line D shows `passes={}` next to
`spec-review-2`, i.e. the escalation budget reset while the filename ordinal did not regress.

## 3. `hpipe rewind` is safe, and the #19 escapes land somewhere that works

Line D is the original defect's own command: rewinding a task onto a review row reserves a fresh path
(`docs/superpowers/reviews/issue-99-spec-review-2.md`), reports `existsAlready=false`, does not
clobber `-0.md` or `-1.md`, and the row advances once that file is written. The reserved path reaches
the human through `cmdRewind`'s own result text (`src/cli.ts:391-394`,
`…; counters cleared; next verdict → <path>`), which is necessary because a rewind onto a review row
renders no prompt — `advanceTask` returns `null` for a review row whose verdict is not fresh, so the
task loop never reaches `promptForTaskPhase`. That reasoning is recorded at `src/cli.ts:330-333`.

Both escalation escapes were traced:

- `prompts/escalate.md:13-19` (the `escalated` row's prompt, `src/lib/phases.ts:71`/`:141`) now says the
  rewind "clears every pass counter on that record, not only `{{phase}}`'s, and — when `{{phase}}` is a
  review row — reserves a fresh verdict path and prints it. Write the next review there, not to the
  previous pass's file." Pinned by `test/prompts.test.ts:150-155`.
- `prompts/stall-escalate.md:12-14` (the #19 stall-ladder escalation, rendered at
  `src/supervisor/main.ts:284`) issues the same `hpipe rewind` command with no such sentence. See
  MINOR 1.
- `src/lib/status.ts:25`/`:126` and `src/supervisor/tick.ts:38` and `src/supervisor/stall.ts:189` also
  print the rewind escape. All four routes terminate at the same `cmdRewind`, which prints the
  reserved path itself, so every escape leads somewhere that works.

## 4. #16's bootstrap fires on the path that actually dispatches

Both dispatch paths are covered, by one reader, read **per dispatch**:

- **Registration path** (17 of the last 20 dispatches) — `src/cli.ts:263`,
  `const bootLine = bootstrapLine(repoBootstrap(run.repo_root))`, inside `cmdTask`'s body, evaluated on
  every invocation. It is emitted on both returns (`:267` queued, `:276` dispatched), so a task that
  registers behind a gate and one that dispatches inline both carry it.
- **Supervisor queued branch** (3 of 20) — `src/supervisor/tasks.ts:159`,
  `` `${bootstrapLine(repoBootstrap(run.repo_root))}\n\n` ``, inside the `for (const task of run.tasks)`
  loop at `:146`, so it is re-read for every task in every tick that opens a gate.
- **Worker brief** — `src/lib/worker-prompt.ts:33`,
  `bootstrap_note: briefNote(repoBootstrap(run.repo_root))`, evaluated on every
  `renderWorkerPrompt` call.

There is no caching anywhere: `repoBootstrap` (`src/lib/bootstrap.ts:21-32`) is a bare `statSync`
behind a `try`, no module-level memo, no `Map`, and `grep -rn "repoBootstrap" src/` returns exactly
those three call sites plus the definition. A repo that adds or `chmod +x`es
`.claude/pipeline-bootstrap` mid-run is therefore picked up by the next dispatch, not the next
supervisor restart.

The detector is correct on the edges that matter: `isFile()` is checked before the mode test
(`src/lib/bootstrap.ts:27`) so a *directory* at that path is not reported as runnable, and a missing
repo root degrades to `{ kind: 'none' }` rather than throwing into a prompt render
(`:29-31`). `test/bootstrap.test.ts:23-46` covers all five states. The `not-executable` state is a
distinct report rather than a silent `none` (`:28`), which is the failure mode most likely in practice
given the note at `src/lib/bootstrap.ts:18` that the primary checkout may be parked on a different
branch than the worktree was cut from — and `prompts/dispatch.md:60-67` tells the orchestrator exactly
how to handle a script that is absent in the new checkout versus one that exits non-zero.

The plugin never executes the script — `grep -rn "pipeline-bootstrap" src/` reaches only the constant
at `src/lib/bootstrap.ts:5`. That is the designed non-goal, correctly honoured.

## 5. Requirements passed by both, and duplicated abstractions

**No duplicated abstraction was introduced.** Specifically:

- **Nothing re-derives a verdict path.** One definition of the directory (`src/lib/verdict-path.ts:5`)
  and one of the filename (`:8-10`); `grep -rn "docs/superpowers/reviews" src/` confirms it.
- **Nothing re-implements phase-age arithmetic.** The three pre-existing copies
  (`src/lib/status.ts:12-13`, `src/supervisor/tick.ts:22`, `src/supervisor/stall.ts:19`) are exactly
  the three issue #14 already records; neither PR added a fourth. `grep -rn "ageMinutes\|MS_PER_MINUTE"
  src/` returns no new site.
- **No fourth copy of the escalated-recovery sentence.** #52 *edited* the existing
  `prompts/escalate.md` copy rather than adding one; the other copies
  (`src/lib/status.ts:25`, `:126`, `src/supervisor/tick.ts:38`, `src/supervisor/stall.ts:189`,
  `prompts/stall-escalate.md:14`) are untouched and pre-existing.
- #26 in fact *removed* a duplication: `task.checkout_path ?? run.repo_root` was spelled in both
  `src/supervisor/deliver.ts` and `src/supervisor/tasks.ts` and is now only
  `src/lib/verdict-path.ts:23`, called from `src/supervisor/deliver.ts:125` and
  `src/supervisor/tasks.ts:110`.
- The two new `src/lib/` modules (`verdict-path.ts`, `bootstrap.ts`) do not overlap in responsibility
  and neither re-implements anything the other added.

**Requirements passed by each PR and implemented by neither** — one real instance, plus two
disclosed-but-undischarged promises; all three are MINORs below. Nothing in either spec's component
list (#26 C1–C5, #16 C1–C6) was dropped: the only divergences are review-mandated renames and
substitutions that the shipped code applies and the spec text was never re-edited to match
(`verdictBase` → `artifactBase` at `src/lib/verdict-path.ts:22`, the planned `console.error` inside
`reserveVerdict` → the injected `ReserveWarn` at `src/lib/verdict-path.ts:57`,
`prompts/dispatch.md`'s new subsection placed at the end rather than before **Still registering?**).
Each of those is a spec-text staleness, not a behaviour gap, and each is traceable to a named review
finding.

---

## Findings

### MINOR 1 — only one of the two escalation prompts learned what `rewind` now does

`prompts/escalate.md:17-19` was updated by #52 to tell the reader that the rewind "reserves a fresh
verdict path and prints it. Write the next review there, not to the previous pass's file."
`prompts/stall-escalate.md:12-14` issues the identical command:

```
To resume after they answer:

    {{hpipe}} rewind {{run_id}} {{phase}}{{task_flag}}
```

with no such sentence. This is not cosmetic symmetry: the stall ladder is the route PR #52's own scope
note names as one of the two ways a waiting review row gets unstuck, and
`src/supervisor/main.ts:284` renders `stall-escalate.md` — not `escalate.md` — for every task the
ladder escalates, including from `spec-review`, `plan-review`, `pr-review-intent` and
`pr-review-quality` (`src/supervisor/stall.ts:22` puts `verdict` in `ESCALATING_SIGNALS`). A reader
who arrives via the ladder is told to rewind and is not told that the next review belongs in a new
file. It still works, because `cmdRewind` prints `; next verdict → <path>` in its own output
(`src/cli.ts:394`), so this is an information gap rather than a broken path — but the two prompts now
say different things about the same command, in the same batch that fixed one of them.

**Fix:** carry the same clause into `prompts/stall-escalate.md`, and extend
`test/prompts.test.ts:150-155` to assert it on both files rather than on `escalate.md` alone.

### MINOR 2 — the `dist_note` follow-up issue was promised three times and never filed

`src/lib/worker-prompt.ts:28-32` still hardcodes a berean-os-specific note
(`pnpm install && pnpm turbo build --filter=@repo/core`) into every worker brief, for every repo. #16's
design (`docs/superpowers/specs/2026-09-19-issue-16-design.md:168-172`), its plan
(`docs/superpowers/plans/2026-09-19-issue-16-plan.md:803-804`) and PR #54's body ("It is
task-conditional, not repo-level, so this mechanism does not subsume it; **it wants its own issue**")
each say the same thing. No such issue exists: `gh issue list --state all --limit 100` tops out at #51
and contains nothing about `dist_note` or the worker brief's hardcoded note, and
`grep -rn "dist_note" src/ test/ prompts/ README.md` turns up no follow-up reference either.

This is the same class of loss #16 exists to remove — knowledge that lived in one agent's head for one
session. The immediate blast radius is small (a confusing but harmless sentence in briefs on other
repos), which is why it is MINOR and not more; the pattern is what makes it worth recording.

**Fix:** file it, and reference the number from `src/lib/worker-prompt.ts:28`.

### MINOR 3 — neither task's live verification has been recorded, and both releases have shipped

Both plans end with a live-session runbook that their specs call required rather than optional —
#26's spec step 10 and #16's spec "live verification" checklist — precisely because
`.claude/agents/plugin-dev.md:53-59` records that this suite's DI fakes "have passed clean over real
defects twice". Both were correctly deferred at PR time, with honest "not yet verified live" /
"what cannot be verified yet" sections, because the installed plugin is a pinned GitHub install.

That blocker is now gone: 1.2.11 carried #26 and 1.3.0 carries #16 (`CHANGELOG.md`), so
`herdr plugin install victorstein/herdr-plugin-pipeline` can refresh and both runbooks can run. There
is no artifact anywhere under `docs/` recording that either was performed, and no issue tracks them.
By each spec's own rule a non-observation is uninformative rather than a pass.

The highest-value single check, because it is the one this review could not reach and the one both
changes converge on, is the `bootstrap:` header line appearing in a real `hpipe task` response on a
real run — it exercises #16's registration path and, on the same run, gives #26's reservation a live
ledger to write into.

**Fix:** run both runbooks against a real herdr session and record the observations on #16 and #26,
or open a tracking issue that carries them.

### MINOR 4 — PR #54's permanent record misdescribes the conflict it resolved

PR #54's body (now the squash-merge message of `7b22d07`) states that `src/cli.ts` "had exactly one
hunk, **two adjacent added imports**, resolved by keeping both with `./lib/bootstrap` in its
alphabetical slot". In the shipped file the two imports are `src/cli.ts:4` (`./lib/bootstrap`) and
`src/cli.ts:21` (`./lib/verdict-path`) — seventeen lines apart, in different runs of the import block,
and separated by the eight-line `./lib/ledger` group. The two upstream diffs confirm it:
`git show f406173 -- src/cli.ts` touches the import block at `@@ -10,13 +10,14 @@` while
`git show 7b22d07 -- src/cli.ts` touches it at `@@ -1,6 +1,7 @@`.

The resolution itself is right — both imports are present, both used, alphabetical order held, no
shadowing, `tsc` clean — and the #16 ruling's condition 3 ("surface it rather than resolving it") was
met, since the body records the resolution as authorised. Only the description is wrong, and it is the
permanent record of an explicitly authorised cross-task edit. No code impact.

**Fix:** none required in code; worth a correction if the ruling trail is ever replayed.

---

## Verdict rationale

The sharp risks this review was pointed at all came back clean, and they were checked by execution
rather than by reading: the `cli.ts` seam is correctly resolved and both functions behave as their
specs describe; `artifacts.verdicts` now has exactly one writer and one key-lookup reader, with the
filesystem probe confined to choosing a filename; a `decide` → `answer` → `deliverPendingAnswers`
resume provably does not move the path and the row still advances afterwards; `hpipe rewind` no longer
strands or clobbers and reports the path it reserved; and #16's clause reaches the registration path
that carries 85% of real dispatches, re-read on every dispatch rather than once per run. The phase-entry
enumeration found no commission site that skips reservation and no non-commission site that performs
one. No duplicated abstraction was introduced, and #26 removed one. Both PRs' test figures reproduce
exactly.

The four findings are all MINOR and none of them can drop a review, wedge a row, or hand a worker a
broken checkout. Two of them (1 and 3) are worth doing before the next batch is driven through this
pipeline; the other two are record-keeping.

VERDICT: CLEAR
