# PR #44 — stage-1 INTENT review (pass 0)

Reviewed `fix/21-run-resolution` at `74fc541` (base `9e792b5`) against issue #21 (as rescoped
2026-09-18 to also close #36 and #38), `docs/superpowers/specs/2026-09-18-issue-21-design.md`
(pass 1) and `docs/superpowers/plans/2026-09-18-issue-21-plan.md` (pass 1).

## What I verified, and how

- **Suite and types, read off their own output.** `bun test` → 483 pass / 0 fail / 1156 expect() /
  34 files. `bun run typecheck` → silent, exit 0. Both match the PR body.
- **The new tests bite.** I rebuilt the branch's tree in a scratch directory (`git archive HEAD`),
  restored `src/` and `prompts/` from `9e792b5` over it, and ran the suite there: **16 named
  failures plus the whole of `test/ledger.test.ts`** (`SyntaxError: Export named 'resolveRun' not
  found`), 450 pass / 17 fail. Every regression test the PR body names is in that list, including
  #21's own (`task registers into this repo run, not another repo run that sorts first`), #36's
  (`brief renders the live run brief when a finished run holds the same task id`) and #38's
  (`decide refuses a task in a finished run and writes nothing`). The one exception the PR body
  discloses — `task run from a linked worktree registers into the parent repo run` — is indeed
  absent from the failure list, exactly as disclosed. Nothing was found to be vacuous that the PR
  did not already flag.
- **The live replay reproduces.** I copied `~/.local/state/herdr/plugins/stein.pipeline/` into a
  scratch dir and pinned `HERDR_PLUGIN_STATE_DIR` at the copy (the live directory was read only,
  never the target). `hpipe brief --task t1` in session `pipeline`: base `src/` renders
  `# fix/9-artifact-paths — issue #9`; this branch renders `# fix/21-run-resolution — issue #21`
  and names run `…-v0qh`. That is #36, byte-for-byte as the PR body states.
- **`repoContext`'s derivation is correct on the real machine.** From this worktree,
  `dirname(--git-common-dir)` = `/Volumes/stein/Documents/development/personal/herdr-plugin-pipeline`,
  which is byte-equal to the `repo_key` in every live run file. I also checked the symlink hazard
  the derivation could have introduced — a repo under `/var` (symlink to `/private/var`) resolves
  identically through `--show-toplevel` (main checkout) and `dirname(--git-common-dir)` (worktree),
  so `hpipe start` and a worker's `hpipe decide` still agree. `src/actions/claim.ts` importing
  `../cli` does not trip `import.meta.main` — actions run as `bun run src/actions/claim.ts`, nothing
  is bundled — and I ran the action end to end against a temp state dir: exit 0, orchestrator file
  written.
- **No first-match resolution survives.** The only `listRuns(...).find(...)` left in `src/cli.ts`
  are by explicit `run_id` (`:257` rewind, `:448` abort, `:460` resume) plus `cmdStatus` (`:431`)
  and `runForWorkspace` (`:478`) — every one of them a spec non-goal.
- **The sibling task's files are untouched.** `gh pr diff 44 --name-only` contains none of
  `src/lib/phases.ts`, `src/supervisor/stall.ts`, `test/phases.test.ts`, `test/stall.test.ts`.

## Acceptance criteria

Every direction in all three issues is either implemented or explicitly rejected with reasoning in
the spec — no silent reduction.

| Asked | Where | Status |
|---|---|---|
| #21: filter candidate runs by `repo_key` | `src/lib/ledger.ts:168` | met |
| #21/#36/#38: `--run <run-id>` | `src/lib/ledger.ts:153-165`, wired at `src/cli.ts:579`, `:587`, `:597`, `:611`, `:621`, `:632` | met |
| #21/#36/#38: fail loudly on ambiguity, naming candidates | `src/lib/ledger.ts:177`, `src/cli.ts:70-73` | met |
| #21: the no-match error names what it looked for | `src/cli.ts:51-57`, `:75-77` | met (see MINOR 1) |
| #36/#38: exclude terminal runs | `src/lib/ledger.ts:170-173` | met |
| #38: one shared resolver across the four commands | `resolveRun`, used by six | met (expanded — see below) |
| #38: refuse to move a task in a terminal run, or a terminal task, into `blocked-on-decision` | `src/cli.ts:376-381` plus `allowTerminal: false` | met, both halves |
| #38: rewind clears a stale decision on a terminal target | `src/cli.ts:284-296` | met, and the ordering against the `pending_answer` block is pinned by a test |
| #36: the brief names its run | `src/lib/worker-prompt.ts:18`, `prompts/worker-brief.md:3-4` | met |
| all three: "consider session-unique task ids" | spec *Non-goals* and *Rejected alternatives* | considered, rejected with evidence (`schema_version` 2 on disk, `README.md:104` refuses rather than migrates) |
| the PR carries `Closes #21` / `Closes #36` / `Closes #38`, one per line | PR body | met |

**Scope expansion is real but declared, not silent.** Three things go beyond the literal ask:
`cmdDispatchDone` and `cmdRelease` are wired too (spec *Rejected alternatives*, and #38 asks to stop
the next command inheriting the defect); `cmdRewind` gains phase-argument validation, which rejects
input it accepts today (spec A14 names this "the most attackable addition in pass 1" and offers to
drop it); and `repoContext`'s new derivation changes what `hpipe start` records when run from inside
a worktree (spec A1, argued from `worktree create --cwd {{repo_root}}`). Each is argued in the spec
before the fact and repeated in the PR body. The six files touched outside the task's declared
`--files` are listed in the PR body with a reason each, and none overlaps the sibling task.

**Divergence from the plan:** none that matters. Steps 1–17 are all present and the implementation
is close to verbatim; the one deviation is in step 16's favour — the plan's smoke.md replacement
text said `found no a run …`, the committed text says `found no run …`, which is what the code
actually prints.

**Tests exercise behaviour, not implementation.** The resolver units assert on the *chosen run id*
with fixtures deliberately ordered so the wrong answer sorts first, and the comments record why
(`test/cli-commands.test.ts:339-343`, `:432-435`) — the exact trap plan review 0 caught. The
command-level tests assert the ledger afterwards ("writes nothing", `decisions` length 0, the other
run's `files` unchanged), and `test/cli-argv.test.ts:100-157` goes through the real subprocess argv
path for the worktree, cross-repo and outside-a-repo cases, which is where this class of defect has
twice escaped DI-faked unit tests.

---

## Findings

### MINOR 1 — a no-match tells the operator "a finished run cannot be re-entered" even when nothing was finished

`src/cli.ts:75-77` appends that sentence to every `none` result with a non-empty `excluded` set when
the command has no escape (`cmdTask`, `cmdDecide`, `cmdDispatchDone`). But for `cmdTask` and
`cmdDispatchDone` the query carries `phases: REGISTRABLE` (`src/cli.ts:108`), so `excluded` also
holds runs that are perfectly live and merely past `execute` — `branch-review` and `escalated` are
both non-terminal by design (`src/lib/phases.ts:64-71`, and the spec's A4 relies on that).

Reproduced against a scratch state dir, one run in `branch-review`:

```
found no run in intake, dispatch or execute for k in session personal
  excluded:
  r-20260919-live-br-3d1t (branch-review)
  a finished run cannot be re-entered
```

The run is not finished. The `(branch-review)` on the line above is the true "why", and the closing
sentence contradicts it — which is the opposite of spec Goal 3 ("says which and why"). Fix inline:
condition the sentence on the excluded set actually containing a terminal run, or drop it in favour
of a phase-aware clause.

### MINOR 2 — the escape offered for an *unreadable* excluded run does not work

`resolveRun` puts a run whose phase is in no row into `excluded` (`src/lib/ledger.ts:170-178`), and
`resolveFailure` then offers the command's generic escape — for `cmdBrief`, `--run <run-id> renders
it anyway` (`src/cli.ts:229`). Naming that run instead returns `unreadable`
(`src/lib/ledger.ts:156`), so the suggested recovery is refused:

```
found no live run holding t1 for k in session personal
  excluded:
  r-20260919-broken-smg9 (dnoe)
  → --run <run-id> renders it anyway
$ … --run r-20260919-broken-smg9
r-20260919-broken-smg9 is in dnoe, which is in no phase row — rewind it to a real phase: …
```

Spec MAJOR 3 (applied in pass 1) committed that "where it suggests a recovery, that recovery works".
It terminates rather than loops — the second message names the correct fix — so this is a MINOR, not
a repeat of MAJOR 3. Related and cheap to fix in the same edit: the spec's error-handling table
promised the excluded line would read `<id> has an unrecognised phase: dnoe`, while `runLine`
(`src/cli.ts:36`) prints only `<id> (dnoe)`, which reads as an ordinary phase name.

### MINOR 3 — a missing `--task` produces a worse message than before

`resolveFailure` builds `holding ${query.taskId}` without an empty-string check (`src/cli.ts:54`),
and the argv layer defaults a missing `--task` to `''` (`src/cli.ts:585`, `:609`, `:617`, `:627`). So
`hpipe brief` with no `--task` now prints

```
found no live run holding  for k in session personal
```

— a dangling "holding" and a double space — where it used to print `no such task: `. Neither is
good, but the old one at least pointed at the missing flag. One `=== ''` guard, or an explicit
"`--task` is required" check at the top of the four `--task` commands.

### MINOR 4 — the migrated test call sites are left mis-indented

The `repoKey`/`runId` fields were appended at a deeper indent than the object they close, and the
closing `})` with them, in roughly ten places: `test/cli.test.ts:172-173`, `:197-198`, `:216-217`,
`:238-239`, and `test/cli-commands.test.ts:146-147`, `:168-169`, `:189-190`, `:219-220`, `:289-290`,
`:305-306`, `:317-318`, `:335-336`. Nothing enforces style here (there is no lint script in
`package.json`), so this is cosmetic only — but it is the most visible thing in a 243-line test
diff, and a one-pass reformat costs nothing.

---

No BLOCKER and no MAJOR. The three issues' acceptance criteria are all met, the fix is the single
shared resolver they asked for rather than three patches, the regression tests demonstrably fail
against the unfixed source, and the live replay reproduces #36 and shows it closed. The four MINORs
are all message copy or formatting and can be fixed inline without a re-review.

VERDICT: CLEAR
