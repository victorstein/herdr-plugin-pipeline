# Branch review — `validate-the-silent-gates` (rjms), whole-branch, pass 0

Scope: `main` at `6080943`, the merged result of **#39** (issue **#10**, merged `2006802`) and **#41**
(issue **#13**, merged `dde2d92`). Reviewed against the two design specs, the two plans, the per-task
reviews, and the two orchestrator rulings appended to `gh issue view 10` / `gh issue view 13`.

> Note on the brief: this phase was handed `4a14099` as #39's merge commit. That object does not exist
> here — `git log --oneline -1 4a14099` → `fatal: ambiguous argument '4a14099'`. The merge is
> `2006802` (`fix(cli): validate and echo --files at registration (#39)`). Everything below is against
> `2006802`.

## Gates, run here

```
$ bun test
 454 pass / 0 fail / 1072 expect() calls — 34 files  [9.24s]

$ bun run typecheck   # tsc --noEmit
(no output, exit 0)
```

Matches the stated baseline (454 / 34) exactly. CI on this repo is a PR-title lint plus
release-please (**#35**) and runs no suite, so neither PR's green check is evidence; both numbers
above were produced in this session.

---

## MAJOR 1 — the deferred runbook repair is real, and it is a coverage hole, not a typo

`test/integration/smoke.md:186-188` (the prose the ownership ruling pinned at `:164-165` pre-batch;
confirmed by `git show 343dde4:test/integration/smoke.md | awk 'NR>=164 && NR<=166'`, which returns
these same three lines, shifted +22 by #39's §1 insertion):

```
186: - In the **orchestrator's pane**: a digest, not a worker prompt. Worker prompts go to worker panes;
187:   the orchestrator only gets `[pipeline] run <id> …` digests and the dispatch/merge/close/decision
188:   prompts that are its own.
```

**What it now gets wrong, precisely.** No sentence in it is *false* — `buildDigest`
(`src/supervisor/deliver.ts:28-34`) still heads every digest `[pipeline] run <run_id><phaseNote>`, so
`[pipeline] run <id> …` still matches. The defect is that these three lines are the **only** place in
the runbook that says what an orchestrator digest contains, and they describe the pre-#13 digest.
After `dde2d92` a digest additionally carries, none of it mentioned anywhere in the file:

- a per-line phase box and age — `[plan-review 234m]` — or a transition box `[research → spec]`
  (`src/supervisor/tick.ts:72-76`, `84-98`);
- a task id, branch and issue on every line, replacing the bare `branch (#n, tN) status` form
  (`tick.ts:92-93`);
- an action clause — `YOUR move` / `worker's move` / `needs a human: <rewind cmd>` / `dead end` /
  `nothing for you …` (`tick.ts:26-50`);
- an `also waiting on you:` footer naming tasks that produced no event at all (`tick.ts:107-127`,
  attached at `src/supervisor/main.ts:231-239`).

That matters here for two concrete reasons, not as a style point.

1. **§2 is where an operator is told what to assert about the orchestrator's pane**, and an operator
   who runs the runbook as written will verify none of #13's deliverable. The runbook is this repo's
   only end-to-end gate.
2. **#13 was never observed live and says so.** Its PR body states the installed plugin is pinned to
   `v1.2.1` (`0c35817`) so the supervisor driving the task ran released code, and asks: *"Someone
   should confirm the `→` arrow appears on the tick a phase advances once this is installed."* The
   spec (`docs/superpowers/specs/2026-09-17-issue-13-design.md:886-894`) names
   `test/integration/smoke.md:164-165` as "the natural home for a step" and defers it only because
   the file was ruled to #10. There is now no written-down place for that confirmation to happen.

**A second site, not named in either ruling.** `test/integration/smoke.md:265-266` (§4a step 2) says
the orchestrator's pane "receives the `decision` prompt: the question, the worker's recommendation,
and the exact `hpipe answer` line to run." A task entering `blocked-on-decision` is
`actor: 'orchestrator'` and non-terminal (`src/lib/phases.ts:126-129`) and produces no wake line on
that tick — `hpipe decide` is not a pane event — so it is not in `covered` (`main.ts:221-227`) and
`parkedFooter` will append `- t1 <branch> (#n) [blocked-on-decision 0m] — YOUR move` to that very
delivery. Harmless, but §4a describes the delivery exactly and no longer describes it fully.

Both rulings pre-committed this repair to branch review; it is not fixed here, per this phase's brief.
The orchestrator repairing it should treat `:186-188` and `:265-266` as one edit.

---

## MINOR 1 — `describeWake`'s run-level branch cannot be reached, and a test covers it anyway

`src/supervisor/tick.ts:52-54` declares `WakeLine.task: Task | null`, and `tick.ts:86-89` renders the
`task === null` case against `run.phase` / `run.phase_entered_at`. Every producer of a `WakeLine` is
in the same file — `tick.ts:182`, `tick.ts:195`, `tick.ts:208` — and all three set `task` from
`findTask`, which only returns a match (`tick.ts:134-140`). `grep -rn "wake.push\|WakeLine" src/`
returns nothing else, and `main.ts:122` is the sole consumer. So the branch is dead in production.

`test/tick.test.ts:451` (`a run-level wake line renders without an action rung`) exercises it by
hand-building a `WakeLine` through the local `wakeLine` helper at `test/tick.test.ts:412`. The test
passes, and covers behaviour the supervisor cannot produce — the shape of coverage that this run's
theme is about. Either a run-level event source is intended and should be named in the comment, or
the `| null` and its branch should go.

## MINOR 2 — `prompts/dispatch.md`'s new hand-over rule is unconditioned, and `hpipe brief` does not satisfy it

#39 added, at `prompts/dispatch.md:26-28`:

```
The two header lines above the
brief — `task_id:` and `files:` — are for you and not for the worker: confirm the `files:` line
matches what you declared, then hand over everything from the blank line onward.
```

Correct for `hpipe task`. Verified live in this session against a scratch ledger:

```
$ bun run src/cli.ts task --branch smoke/one --issue 1 --surface core --files src/lib
task_id: t1
files: src/lib

# smoke/one — issue #1
```

But `cmdBrief` (`src/cli.ts:160-167`) returns `renderWorkerPrompt(...)` bare — no `task_id:`, no
`files:`, and its first blank line falls *after* the `# <branch> — issue #<n>` heading
(`src/lib/worker-prompt.ts:33-35`). An orchestrator recovering a brief that way and then following
the rule as written strips the heading. The same omission means the `files:` feedback loop #10 was
filed to create is absent from the one read-only command that exists to re-read a task
(`hpipe brief --task <id>`, added for exactly the lost-context case — `test/integration/smoke.md:397`).

Narrow: `hpipe brief` appears in no prompt and not in `README.md` — `grep -rn "hpipe brief" prompts/
README.md src/` finds only that runbook row — so the misfire needs an orchestrator that already knows
the command. Ranked MINOR on that basis, not because the asymmetry is imaginary.

## MINOR 3 — a third `ageMinutes`, placed where the next issue cannot reach it, behind a comment that misstates the batch

`src/supervisor/tick.ts:7,17-19` adds a third copy of the phase-age arithmetic. The other two are
`src/lib/status.ts:12-14` and `src/supervisor/stall.ts:19,70`. `actionFor` (`tick.ts:26-50`) is a
second, independent formatter of operator guidance that `src/lib/status.ts` already emits — the
escalated-rewind sentence (`status.ts:22-27` vs `tick.ts:31-34`) and the blocked-on-files release
advice, which `tick.ts:38-41` documents as *"Mirrors `src/lib/status.ts:51-60`"*.

Two things make this more than the usual triplication:

1. **The copies now disagree on a live defect.** `status.ts:25` hardcodes the literal `hpipe`, which
   is uninvokable for a GitHub-installed plugin; `tick.ts` renders `hpipeCommand` throughout, which is
   why `describeWake`/`parkedFooter` take `hpipe` as a parameter. So after this branch `hpipe status`
   and the digest hand the operator *different* recovery commands for the same escalated task, one of
   them wrong. #41 flags `status.ts:25` and correctly leaves it to **#14**.
2. **The placement blocks the collapse.** #14 is open —
   *"hpipe status has no phase age and no 'waiting on you', contrary to the README"* — i.e. it needs
   `ageMinutes` and an `actionFor` equivalent in `src/lib/status.ts`. Both now live in
   `src/supervisor/`. The repo's layering is strictly one-way: `grep -rn "from '\.\./supervisor" src/lib/
   src/actions/` returns nothing, against 42 `src/supervisor/ → src/lib/` imports. #14 must therefore
   invert the layering or write a fourth copy. `src/lib/` was the reachable home.

And the deferral comment at `tick.ts:11-13` is wrong on fact: *"`status.ts` belongs to #14 and is
being edited in the same batch"*. It was not. `git log --oneline 343dde4..HEAD -- src/lib/status.ts`
is empty, and this batch was #10 and #13 only. "Whoever lands last collapses the three" has no last
lander, and nothing tracks the collapse.

---

## Verified sound — the specific things this phase was asked to check

**`prompts/digest.md`'s deletion is correct and the guard is now load-bearing.** No live reference
survives: `grep -rn "digest.md" --exclude-dir=.git --exclude-dir=docs .` returns nothing, and no
`renderPrompt` site ever named it. `prompts/` holds 20 files and `test/prompts.test.ts:10-14`'s `ALL`
holds 20 names; the two agree. The no-orphan assertion was confirmed to bite rather than assumed —
recreating `prompts/digest.md` and re-running gives `(fail) no orphan prompt files` at
`test/prompts.test.ts:23`, 15 pass / 1 fail; the file was removed and the tree is clean again
(`git status --short` empty).

**Every remaining placeholder is supplied at every render site.** All rendering goes through
`renderPrompt` (`src/lib/render.ts:40-47`); `render()` has no other caller and nothing else reads
`prompts/`. 19 call sites, 20 templates, 30 distinct tokens, extracted with the production regex
(`render.ts:6`) — **zero** gaps and **zero** templates without a call site. The one runtime-computed
name (`src/supervisor/tasks.ts:68`, `taskRow(task.phase).prompt`) is bounded by the five cases above
it to `research|spec|spec-review|plan|plan-review`, all five satisfied by `taskCommon`
(`tasks.ts:49-60`). So the deletion cannot have orphaned a placeholder, and nothing throws at
delivery. (Aside, pre-existing and not this batch's: `render.ts:44-45` says "eighteen render sites";
there are 19.)

**The seam is clean.** The two changesets touch disjoint operator surfaces and neither claims a format
the other changed. `grep -rn -i "digest" prompts/ README.md .claude/` returns **nothing** — no prompt
and no README passage describes digest content, so #13's rewrite could not contradict #10's prompt
edits. Conversely `src/cli.ts`'s `files:` echo never enters a digest. The one place both changes land
on the same file, `test/integration/smoke.md`, went to #10 alone per the ruling and #13 did not touch
it (`git show dde2d92 --stat` lists no `test/` file but `deliver/prompts/tick`). `README.md:80`,
`prompts/intake.md:24-32` and `prompts/dispatch.md:23-34` now all name the comma separator and the
`files:` line consistently with the verified output.

**#13's scope boundary was honoured and nothing depends on #19.**
`git diff --stat 343dde4..HEAD -- src/lib/phases.ts src/lib/types.ts src/lib/machine.ts
src/lib/status.ts` is empty — all four untouched. The Non-goal naming #19 exists
(`…issue-13-design.md:224-233`, and #19 is cited at `:44`, `:105`, `:222`, `:226`, `:449`, `:726`,
`:939-941`), A10 was rewritten to the measured distribution (`:693-729`, with the two zero-transition
windows at 85.9% of the span and t3's 79%), and §Resolution no longer claims the acceptance sentence
is met (`:91-116`). `parkedFooter`'s membership test (`tick.ts:112-118`) reads only fields that exist
today — `row.terminal`, `row.actor`, and the spelled-out `escalated` — so it degrades to an empty
footer rather than depending on a `stallable` flag #19 has not added. #19, #14 and #37 are all open
and real.

**#10's validation rejects the invocation that motivated it, and the echo renders.** Run live against
a scratch git repo and pinned `HERDR_PLUGIN_STATE_DIR`:

```
$ bun run src/cli.ts task --branch smoke/bad --issue 999 --surface core --files "src/a.ts src/b.ts"
--files is comma-separated; this entry contains whitespace: "src/a.ts src/b.ts"
  → --files src/a.ts,src/b.ts
exit=1

$ bun run src/cli.ts task --branch smoke/one --issue 1 --surface core --files src/lib
task_id: t1
files: src/lib
…
$ bun run src/cli.ts task --branch smoke/two --issue 2 --surface core
task_id: t2
files: none
```

The rejection also registers nothing — the next task minted `t1`, not `t2`, which is the property
`test/integration/smoke.md:104-109` depends on. The check sits at `src/cli.ts:76-93`, before the task
literal is built at `:95`, which is what makes that true given no command removes a task.

**`actionFor`'s rungs are exhaustive and its one subtle predicate is right.** `blocked-on-files`
carries no `actor` (`phases.ts:105-106`), so the rung at `tick.ts:37-48` is reachable rather than
shadowed by the `actor` rungs above it. Its `stuck` find ANDs `isInFlight` with
`terminal || escalated`; intersected against `TASK_ROWS` that is exactly `{failed, escalated}` — the
only two rows that both hold files (`holdsFiles: true`) and will never release them — since
`orphaned`, `blocked-on-failure` and `done` are `holdsFiles: false` and so fail `isInFlight`
(`src/lib/gating.ts:23-29`). Same set `status.ts:53` computes. No dead rung, no wrong advice.

**No cross-task duplication.** Item 5 of the brief asked for the two workers independently solving the
same sub-problem. There is none: argv handling was touched only by #10 (`src/cli.ts:366-383`), phase-age
formatting only by #13, and #10's single operator-output builder (`src/cli.ts:139`) shares no domain
with `describeWake`/`parkedFooter`. The duplication that exists is MINOR 3 — internal to #13 and
pre-existing in kind.

---

## Summary

No BLOCKERs. The two changesets are independently sound and compose cleanly: the file-ownership ruling
removed the race rather than papering over it, #13's scope ruling was honoured to the letter including
the three required spec corrections, the digest rewrite's one genuinely subtle predicate
(`blocked-on-files` holders) is correct against the phase table, and the `prompts/digest.md` deletion
is the rare case where a guard was made load-bearing rather than merely asserted — confirmed here by
breaking it. The single MAJOR is the open item the orchestrator pre-declared: the runbook's only
description of a digest is now the pre-#13 one, at `smoke.md:186-188` and again at `:265-266`, and
that matters because it is this repo's only end-to-end gate and #13's PR states plainly that its
change was never observed live. The three MINORs are a tested-but-unreachable branch, an
unconditioned hand-over rule that `hpipe brief` does not satisfy, and a third copy of the phase-age
helper placed where the open issue that needs it cannot import from, behind a comment that misstates
which files this batch edited.

MAJORS: 1
MINORS: 3

VERDICT: CLEAR
