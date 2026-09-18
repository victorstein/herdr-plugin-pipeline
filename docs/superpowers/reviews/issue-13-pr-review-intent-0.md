# PR #41 — stage 1 intent review (issue #13)

**PR:** #41 `fix: put the phase, age and next action in every digest line`
**Branch:** `fix/13-digest-content` — head `8c06f67481a922c4cd17fac3d1924ee19386b2a3`
**Reviewed against:** issue #13 (Directions + the 2026-09-17 **ownership ruling** and **Scope
ruling**), `docs/superpowers/specs/2026-09-17-issue-13-design.md` (v4),
`docs/superpowers/plans/2026-09-17-issue-13-plan.md`, and the four prior reviews on disk.
**Scope of this pass:** intent only. Code quality is stage 2 and is not reported here.

## Method

Ran both gates in the worktree; re-derived the file set from GitHub rather than from a local
`git diff` (the local `main` ref is stale and shows #10's merged work as if it were this branch's);
replayed the PR's own "After" block against the real berean-os ledger; and probed two test-guard
claims by mutating a scratch copy of the tree (the worktree itself was not modified — `git status`
clean, HEAD unmoved at `8c06f67`).

---

> **Tree state at the time of writing.** Everything below was derived at head `8c06f67`, which is
> the PR head and where `git rev-parse HEAD` still points. Partway through this pass an
> **uncommitted** edit to `test/tick.test.ts` appeared in the shared worktree from another session,
> rewriting both exhaustiveness guards and reversing the footer fixture's task order — i.e. exactly
> MINOR 1 and MINOR 2 below. It is not part of PR #41 (`gh pr view 41 --json files` and the head sha
> both predate it) and nothing in this review was taken from it. Both findings stand against the PR
> as pushed; if that edit is committed, both are resolved and neither needed a decision anyway.

> **Remediation, added by the task author after the verdict landed.** That edit was mine, applied on
> reading this review; it was committed as `a646554` together with this file. Both MINORs are fixed
> and each fix was re-probed: deleting the footer sort now fails one test, and the synthetic
> `actor: 'human'` row fails two, naming both defects. The MINOR 1 and MINOR 2 citations below
> describe `test/tick.test.ts` **as it stood at `8c06f67`** — the findings were correct against that
> file and the line numbers no longer resolve against the current one.

## Findings

### MINOR 1 — the footer's `task_id` ordering is unpinned; spec **T19** is only half implemented

`src/supervisor/tick.ts:116` sorts the footer by `task_id`, and spec §Testing strategy **T19** asks
for *"two tasks in `merge` and `blocked-on-decision` | both listed, **stable order by `task_id`**"*.

The implemented footer test (`test/tick.test.ts:469-484`) uses `t1`/`t2` **already in sorted order**,
so the sort never has to do anything; `test/tick.test.ts:519-529` (the membership guard) uses one
task at a time. Membership for `blocked-on-decision` is covered by that guard, so only the ordering
half is missing.

**Evidence (probe, scratch copy):** deleting the `.sort((a, b) => a.task_id.localeCompare(b.task_id))`
line at `src/supervisor/tick.ts:116` leaves `bun test test/tick.test.ts` at **42 pass / 0 fail**.
No test in the suite would notice the sort being removed.

**Fix (inline):** in `test/tick.test.ts:469`, declare the two tasks in reverse (`t2` before `t1` in
`run.tasks`) and keep the existing sorted expectation. One-line change, no behaviour change.

### MINOR 2 — both `TASK_ROWS` exhaustiveness guards are implementation restatements and do not bite for the case the spec says they guard

The spec justifies these guards as *"A row added with a new `actor`/`terminal` combination then fails
here rather than shipping an empty clause"* (§Testing strategy, Exhaustiveness guard). Neither guard
achieves that:

- `test/tick.test.ts:336-354` (`actionFor` over `TASK_ROWS`) asserts the clause is non-empty and is
  one of five known strings or a command clause. `actionFor`'s rung 7
  (`src/supervisor/tick.ts:47`) is an unconditional catch-all, so an empty clause is already
  unreachable and any new row lands on a **known** string by construction.
- `test/tick.test.ts:519-529` (footer membership) computes `expected` as
  `row.terminal !== true && (row.actor === 'orchestrator' || row.phase === 'escalated')` — the same
  expression as the implementation at `src/supervisor/tick.ts:110-114`. Expected and actual move
  together, so it cannot fail for a new row at all.

**Evidence (probe, scratch copy):** adding a new non-terminal row
`{ phase: 'awaiting-signoff', actor: 'human', signal: 'manual', holdsFiles: false }` to `TASK_ROWS`
leaves `bun test test/tick.test.ts` at **42 pass / 0 fail**, while that row silently ships
`nothing for you — the supervisor is driving` (false for a human-owned row) and no footer line.

This is **not a deviation** — the PR implements the guard shape the spec specifies, verbatim — and
today's twenty rows are pinned behaviourally elsewhere (`test/tick.test.ts:265-293` enumerates every
phase's clause; `:492-500` enumerates the rows the footer must not list), so shipped behaviour is
correct. It is recorded because the PR body advertises these two as the guards that catch the class
rather than the instance, and they do not. The honest claim is that they catch a regression in the
two functions, which they do.

**Fix (inline, optional):** assert the *clause* per row from the table (`actor`/`terminal` →
expected clause) rather than membership in a set of known strings, or leave as is and drop the
"catches the class" framing. Either is fine; not blocking.

---

## What was verified, and found sound

Recorded so a later pass does not re-derive it.

**Gates — both claims reproduced exactly.**

```
$ bun test          → 454 pass / 0 fail / 1072 expect() calls, 34 files
$ bun run typecheck → tsc --noEmit, no output, exit 0
```

**The forbidden-file list is respected.** `gh pr view 41 --json files` lists fourteen paths; none is
`src/cli.ts`, `prompts/intake.md`, `prompts/dispatch.md`, `README.md`, `src/lib/status.ts`,
`src/lib/phases.ts` or `test/integration/smoke.md`. (A local `git diff main...HEAD` *does* show
`src/cli.ts`, `prompts/intake.md`, `prompts/dispatch.md` and `README.md` — that is the stale local
`main` ref replaying #10/#39, not this branch. Checked before writing anything.)

**Both PR-body claims the brief flagged are true.**

1. *Live verification was impossible from here.* `herdr plugin list --json` reports
   `"kind":"github"`, `"requested_ref":"v1.2.1"`, `"resolved_commit":"0c35817236923c12835a13fe14ac372faac1ce6c"`,
   `plugin_root: /Volumes/stein/.config/herdr/plugins/github/stein.pipeline-f39fb4f3495d` — the
   installed supervisor is released code at a different root, not this checkout.
   `.claude/agents/plugin-dev.md:40-51` ("The self-hosting hazard") is what makes pointing it at this
   branch off-limits. Plan step 11 therefore could not be executed; the PR says so plainly rather
   than claiming it, and names the exact residual (`main.ts`'s tick ordering) with a request for
   someone to confirm the `→` arrow post-install. Divergence from the plan, explained and verified.
2. *`src/supervisor/main.ts` is outside the declared `--files` set and the sibling does not overlap.*
   From `…/runs/pipeline/herdr-plugin-pipeline-20260917-validate-the-silent-gates-rjms.json`:
   `t2.files = ["src/supervisor/tick.ts","src/supervisor/deliver.ts","prompts/digest.md"]`,
   `t1.files = ["src/cli.ts","prompts/intake.md","prompts/dispatch.md","README.md"]`. Under
   `filesOverlap`'s prefix test (`src/lib/gating.ts:19-21`) no pair overlaps `src/supervisor/main.ts`.
   Declared in the spec as **A11**, not discovered after the fact.

**The PR's "After" block is a real render, not an illustration.** Replaying `describeWake` /
`parkedFooter` / `buildDigest` from this head over the live berean-os ledger
(`…/runs/personal/berean-os-20260916-berean-os-issue-batch-ujku.json`) at the run's abort stamp
`2026-09-17T03:44:34.471Z` reproduces the PR body byte for byte, including `[plan-review 234m]`,
`[merge 297m]` and t4's clamped `[blocked-on-decision 0m]`.

**Issue #13's Directions are met for every line the digest emits.** The only producer of digest event
lines is `wake`, and `src/supervisor/main.ts:220-226` routes all of them through `describeWake`.
`src/supervisor/tick.ts:81-95` renders `<task_id> <branch> (#<issue>) [<phase-box>] <event> — <action>`:
task id, phase, age (or the `→` transition, per **A3**), and the action clause. `agent_status`
survives only as `agent:<status>` (`src/supervisor/tick.ts:206`), which is the specific misreading
the issue was filed over.

**Both orchestrator rulings are complied with in substance.**

- *Ownership ruling.* `test/integration/smoke.md` is untouched by this PR, and the staleness is
  recorded in §Non-goals naming the ruling and deferring the repair to `branch-review` — exactly
  what the ruling demanded instead of leaving it unmentioned. (The spec cites `smoke.md:164-165`;
  after #10 landed the prose now sits at `:186-187`. Citation drift in a doc, not a defect.)
- *Scope ruling.* `src/lib/phases.ts` is not in the diff. §Resolution no longer claims C3 closes the
  parked-task gap and the PR body repeats the disclaimer. A10 carries the measured distribution
  (two zero-transition windows, 85.9% of span, 79% of t3's park) and names `merge` + `escalated` as
  the genuinely new coverage. §Non-goals names **#19** as the owner. MAJOR 1 (`DigestInput.footer`
  optional — `src/supervisor/deliver.ts:19`, and `test/deliver.test.ts:33-51`, `:53-81`, `:121-130`
  compile untouched) and MAJOR 2 (`escalated` in the footer predicate — `src/supervisor/tick.ts:114`)
  are both taken.

**Every spec component is implemented, including the parts easy to skip.**

- **C1** — `WakeLine.text` is gone; `event` + `phaseAtEvent` replace it (`src/supervisor/tick.ts:49-67`),
  `phaseAtEvent` is captured at `:171` *before* the forced `failed` at `:178`/`:192`, and
  `test/tick.test.ts:366-377` pins that (`pane exited` reports `implement`, not `failed → failed`).
  The blocked-tail gate moved to `line.event === 'agent:blocked'` (`src/supervisor/main.ts:128`), and
  `test/tick.test.ts:389-402` pins the `blocked`-then-`idle` drain that the old per-task gate could
  not distinguish.
- **C2** — all seven rungs present and in the spec's order (`src/supervisor/tick.ts:23-49`),
  including rung 6's `hpipe release` escape hatch (**A17**), with its three cases tested
  (`test/tick.test.ts:305-334`: dead holder, live holder, non-overlapping holder). Rung 3 renders the
  injected `hpipe` and `test/tick.test.ts:295-303` asserts the literal never appears.
- **C3** — `parkedFooter` (`src/supervisor/tick.ts:104-123`), attached to every orchestrator-pane
  pending (`src/supervisor/main.ts:234-241`) rather than only the first, which is the pass-2 MAJOR 2
  wiring; `test/deliver.test.ts:353-369` uses the two-pending form the plan review demanded and also
  pins single rendering via `group.find`. `buildDigest`'s tail join
  (`src/supervisor/deliver.ts:24-34`) is byte-identical with no footer
  (`test/deliver.test.ts:348-351`) and one blank line when `nextPrompt` is empty (`:337-346`).
- **C4** — `prompts/digest.md` deleted and `'digest'` removed from `ALL`
  (`test/prompts.test.ts:10-14`). The orphan assertion at `test/prompts.test.ts:21-24` reads the real
  directory, so re-adding the file without wiring now goes red. The claim holds.
- Plan-review findings all landed: T23c's two-pending form (MAJOR 1), T10 (MAJOR 2), T25/T26
  (`test/tick.test.ts:506-517`) and T9's `not.toContain('intake')` (`test/tick.test.ts:291`).

**No scope expansion.** Four exported functions, all specified; one out-of-set source file, declared
in advance; no schema, phase-table or `stall.ts` change. The one addition beyond spec and plan is the
source-text guard at `test/tick.test.ts:456-467` (`hpipe` declared once, above its first use). It is
justified in the PR body by a real TDZ bug the author introduced and caught by reading, it bites as
written (`src.indexOf('describeWake(')` matches the call site, not the import), and it lives inside
this task's own test file. Accepted as in-scope.

**Non-findings, checked and dismissed:** hoisting `hpipeCommand` above the run loop changes call
count by zero and both positions sit under the same outer `try` (`src/lib/render.ts:28-38` is a pure
lookup); `tickNow` being captured before `advanceTasks` can only make a just-entered phase read
`0m`, which the `Math.max(0, …)` clamp already specifies (**A4**, `test/tick.test.ts:257-263`);
passing the footer to a task prompt only when its pane is the orchestrator's
(`src/supervisor/main.ts:237-238`) is equivalent to the spec's unconditional form, because
`deliveriesFor` only builds a digest for `isOrchestrator` groups (`src/supervisor/deliver.ts:70-77`);
and `smoke.md:186-187` is the only remaining stale prose anywhere in `prompts/`, `README.md` or
`.claude/`, which is the deferred repair the ownership ruling already assigned.

---

Two MINORs, both test-strength observations, both fixable inline without a decision. Nothing reverses
a decision, changes scope or needs the human. The acceptance criteria, the spec's four components and
both rulings are all satisfied, and the two claims the PR asked to be checked rather than trusted are
true.

VERDICT: CLEAR
