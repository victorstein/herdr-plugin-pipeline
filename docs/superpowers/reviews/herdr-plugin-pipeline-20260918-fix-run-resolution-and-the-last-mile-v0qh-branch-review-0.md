# Branch review — run `herdr-plugin-pipeline-20260918-fix-run-resolution-and-the-last-mile-v0qh`

Whole-branch adversarial pass over the merged result of **PR #44** (issue #21, rescoped to close
#21/#36/#38) and **PR #47** (issue #19), at `f0a3522` (release 1.2.9) on `main`.

Pass 0. Reviewed against the orchestrator sections appended to both issues mid-run — #21's
*"Scoped 2026-09-18 as the shared fix for #21, #36 and #38"* and #19's *"Ownership ruling —
`test/integration/smoke.md`, 2026-09-19"* — which govern over the original issue text.

## Gates, run here

```
$ bun test
 503 pass
 0 fail
 1265 expect() calls
Ran 503 tests across 34 files. [8.86s]

$ bun run typecheck
$ tsc --noEmit
exit=0
```

Matches the stated `main` baseline of 503 pass / 34 files. CI in this repo is a PR-title lint only
(#35), so these are the only gates that ran on either PR's content; a green PR here is not evidence.

Measured the batch's real arithmetic by checking the trees out (`git worktree add --detach`). Each
release commit touches only `.release-please-manifest.json`, `CHANGELOG.md`, `herdr-plugin.toml`
and `version.txt`, so the test tree at each release equals the tree of the PR below it:

| tree | `bun test` |
|---|---|
| `2016ee0^` (= 1.2.7, pre-#44) | **454 pass** / 34 files |
| `2016ee0` (= 1.2.8, post-#44) | **488 pass** / 34 files |
| `2e8f9fd` (= 1.2.9, post-#47, == `main`) | **503 pass** / 34 files |

`git diff d52a905 2e8f9fd -- src test` is empty, so #47's squash merge carried its head tree intact.

---

## 1. The seam: #19's stallable rows against #21's resolver

No interference found. Checked empirically rather than from the specs, by driving the real modules.

**#19's ladder can only reach rows #21's resolver would also act on.** `taskStallCandidates` skips
any run whose *run* row carries `releasesPane` (`src/supervisor/stall.ts:98`), which is exactly
`escalated` and `done` (`src/lib/phases.ts:70-72`). `resolveRun` excludes any run whose row is
`terminal` (`src/lib/ledger.ts:143-149,177-180`), which is `done` alone. Driving every run phase
with a task parked in `merge`:

```
run.phase=intake         releasesPane=false terminal=false taskCandidates=1
run.phase=dispatch       releasesPane=false terminal=false taskCandidates=1
run.phase=execute        releasesPane=false terminal=false taskCandidates=1
run.phase=branch-review  releasesPane=false terminal=false taskCandidates=1
run.phase=escalated      releasesPane=true  terminal=false taskCandidates=0
run.phase=done           releasesPane=true  terminal=true  taskCandidates=0
```

The probe-suppressing set is a strict superset of the resolver-refused set, so **the ladder can
never probe a row that every command then refuses.** The one-way divergence — `escalated` runs are
silent to the supervisor but still open to commands — is MINOR 3 below.

**The probe text never names a command the resolver can bounce.** Every escape the five new clauses
emit is either a `gh` invocation or `hpipe rewind`, and `cmdRewind` deliberately does not go through
`resolveRun` (`src/cli.ts:308`, and `rewind` is in the `byIdOrNothing` deny-list at `:565`). It
addresses a run by id with no repo filter and no terminal guard, so the recovery a probe prints
works on a run that `hpipe task`/`decide`/`dispatch --done` would refuse. The `escalated` clause
(`src/supervisor/stall.ts:186-190`) and `status.ts:25` print the same `rewind` line for the same
reason, and both remain executable.

**#21 did not move any phase the ladder reads.** `git show 2016ee0 --stat` lists no
`src/lib/phases.ts` and no `src/supervisor/`; #47's four declared files were untouched by #44, as
its rebase note claims.

## 2. #19's safety property — verified against the merged code, not the spec

The claim is that all five rows become `stallable: true` but **no row gains the ability to
escalate**, so a correctly-parked task can never be pushed into `TERMINAL_BAD`
(`src/lib/gating.ts:6-8`) and cascade its dependents to `blocked-on-failure` (`:34-38`).

It holds, structurally and empirically.

Structurally: `escalatable` is derived only from the row's signal —
`ESCALATING_SIGNALS = {artifact, verdict, pr}` (`src/supervisor/stall.ts:22`, read at `:63`), and
`action` is `'escalate'` only when `escalatable && probes >= probeMax` (`:67`). The five rows carry
`ci`, `merged`, `closed`, `worktree` and `manual` (`src/lib/phases.ts:122-142`). `applyStalls`
(`:335-341`) returns before the escalate branch for every `'probe'` candidate, so `escalate()`
(`:365`) — the only caller of `enterTaskPhase(…, 'escalated')` on this path — is unreachable for
them.

Empirically, driving `taskStallCandidates` + `applyStalls` through 40 intervals of 45 minutes with a
`sendEscalation` spy, per row:

```
ci         probes=39 escalations=0 finalPhase=ci
merge      probes=39 escalations=0 finalPhase=merge
close      probes=39 escalations=0 finalPhase=close
teardown   probes=39 escalations=0 finalPhase=teardown
escalated  probes=39 escalations=0 finalPhase=escalated
```

The resulting partition is 9 / 9, with no row in both:

```
escalating : branch-review, research, spec, spec-review, plan, plan-review,
             implement, pr-review-intent, pr-review-quality
probe-only : dispatch, execute, blocked-on-files, ci, merge, close, teardown,
             blocked-on-decision, escalated
```

Every clause is also true and non-generic. Rendering `stallAwaiting` for all five rows at `pr=42`
and `pr=null` produced no `whatever clears <phase>` fallback and no leaked `{{…}}` — which matters
because `render` never re-scans replacement text (`src/lib/render.ts:8-14`) and throws on an
unresolved placeholder (`:11`):

```
ci/pr=42        short="CI on PR #42"
ci/pr=null      short="a PR number this task never recorded"
merge/pr=42     short="PR #42 to be merged"
merge/pr=null   short="a PR number this task never recorded"
close/*         short="issue #7 to close"
teardown/*      short="its worktree to be removed"
escalated/*     short="a human to act on the escalation"
```

The `escalated` row needed `probeTarget: 'orchestrator'` because `actor: 'human'` resolves to no
pane (`src/supervisor/stall.ts:13-17`); it has it (`src/lib/phases.ts:140-142`), and
`test/table.test.ts:30-37` now fails loudly if a future stallable row forgets one. `merge` and
`close` correctly omit it — `actor: 'orchestrator'` already resolves.

The one behavioural consequence worth stating plainly, and it is intended rather than a defect: a
task the human has deliberately parked in `escalated` is now nudged in the orchestrator pane every
`TASK_STALL_MINUTES` **forever**, with no cap. `ladderFor` (`:298-305`) says so in the prompt
("This is a standing nudge"), and the issue asked for exactly this.

## 3. `test/integration/smoke.md` — both ruled sites repaired

Both stale sites named in the Ownership ruling were actually rewritten, in the same commit as the
code.

- **The footer bullet** (ruling cited `:199-204`, now `test/integration/smoke.md:199-207`). All
  three false assertions are gone: "the footer is the only thing that reports it" became "on a tick
  that is already sending a digest the footer is what reports it"; "a genuinely quiet window shows
  nothing" was replaced by a new bullet asserting the opposite; and "that residual gap is issue #19,
  not a defect here" — the pointer at a now-closed issue — is deleted. The replacement bullet
  (`:203-207`) states what the operator should now see, and its three assertions all check out
  against the code: the five rows are probed in the orchestrator's pane, no clause falls back to
  `whatever clears <phase>`, and none escalates. The remaining `(#19)` on `:204` is an attribution,
  not an open-issue pointer.
- **§4c** (ruling cited `:359-361`, shifted to `:369-374` by #44's edits). Rewritten to nine rows
  from four, naming the last mile and `escalated`, and describing what each probe says. The count is
  correct — see the 9/9 partition above.

Nothing else in the file went stale from either PR, checked line by line against the code:

- `:133-135` — #44's new failure string. `phraseFor` + `resolveFailure` (`src/cli.ts:31-36,57-62,81`)
  do render `found no run in intake, dispatch or execute for <repo> in session <session>`.
- `:276-278`, `:309-310` — `--run` guidance for `decide` and `answer`. Matches `cmdDecide`
  (`src/cli.ts:404-407`, `allowTerminal: false`) and `cmdAnswer` (`:440-444`, terminal reachable
  only when named).
- `:555-557` — the `hpipe rewind` gotcha, inverted by #44. Matches `cmdRewind`'s table validation
  (`src/cli.ts:316-321`) and the terminal-phase decision abandon (`:341-350`).
- `:242-245`, `:253`, `:255-256` — which phases hold files, and `release` refusing an in-flight
  holder. Unchanged by both PRs and still true (`src/lib/phases.ts:122-148`, `src/cli.ts:388`).
- `:191` — the `actionFor` vocabulary. Still matches `src/supervisor/tick.ts:34-54`.
- `:199-202` — the parked footer covers `merge`, `close`, `blocked-on-decision`; those three are the
  `actor: 'orchestrator'` rows `parkedFooter` selects (`src/supervisor/tick.ts:127-130`). It
  correctly does not claim `ci`/`teardown` are in the footer, which they are not.

One pre-existing inaccuracy in the section #19 took ownership of survives — MINOR 2.

The ruling's premise that `smoke.md` was "contested by nobody" was already false when it was
written: **#44 had merged four hours earlier and had edited `smoke.md` itself** (`git show 2016ee0
--stat` lists it, +20/−0 net across three hunks, and #44's own PR body declares it as taken outside
its `--files`). No content was lost — #47 rebased onto `b31c3bb`, which contains #44, and the two
edit disjoint regions — but the ruling's reasoning did not hold on the facts, and this is #37's
third consecutive occurrence as #19's PR body says.

## 4. #21's requirements — what shipped and what did not

Read against the issue's **"What the fix has to do"** list, not the PR title.

| Asked | Shipped | Evidence |
|---|---|---|
| One shared resolver used by all four commands, filtering `repo_key`, excluding terminal runs | **Yes**, and by six | `resolveRun` (`src/lib/ledger.ts:154-186`); `cmdTask:176`, `cmdBrief:280`, `cmdDispatchDone:296`, `cmdRelease:379`, `cmdDecide:404`, `cmdAnswer:440` |
| Fail loudly on ambiguity, and say what was searched for | **Yes** | `reason: 'ambiguous'` (`ledger.ts:184`) → `more than one <scope>` + candidate list + `→ name one with --run <run-id>` (`cli.ts:76-79`); the scope string names phases, task id, repo and session (`cli.ts:57-62`) |
| `--run <run-id>` | **Yes** | `RunQuery.runId` (`ledger.ts:116`, branch at `:159-171`); wired for all six (`cli.ts:599,607,617,631,641,652`); empty value rejected (`cli.ts:105-107`) |
| Refuse to mutate a terminal run, mirroring `cmdAnswer`'s guard | **Yes** | run level: `allowTerminal: false` on `task`/`dispatch --done`/`decide` (`cli.ts:174,294,406`); task level: `cmdDecide` now refuses a finished **task** (`cli.ts:424-427`), which is #38's core |
| Give `hpipe rewind` a way to clear a stale decision, **or** discard unanswered decisions when rewinding to a terminal phase | **Yes** (the second arm, which the issue's "or" permits) | `cli.ts:341-350`, with `escalated` deliberately excluded because it carries `returnsTo`; tested both ways (`test/cli-commands.test.ts:500`, `:519`) |
| *Consider* making task ids unique per session | **No** — and correctly so | Ids are still per-run (`cli.ts:229` mints `t${n}`); the issue only asked for it to be weighed against the on-disk shape, and #44's "No schema change" section records the call |

So: **every mandatory item shipped.** The only unimplemented direction is the one the issue marked
"Consider", and it was consciously declined with a stated reason. Two things went beyond the issue
and are worth recording because per-task review could take them for granted:

- `repoContext` (`src/lib/repo.ts:17-25`) derives the repo a linked worktree *shares*, via
  `dirname(--git-common-dir)` when `--git-dir` differs. Implementing the issue's filter literally
  against `--show-toplevel` would have broken `hpipe decide` for **every worker in the fleet**,
  since a worktree's toplevel never equals `repo_key`. Covered by
  `test/cli-argv.test.ts:100,141`. Existing runs on disk keep working: both forms agree in a main
  checkout, so `repo_key` values written before #44 still match.
- The residual after a **non-terminal** rewind out of `blocked-on-decision` — the open decision
  survives and `hpipe status` keeps printing `⚠ tN blocked on an open decision`
  (`src/lib/decisions.ts:3-5`, `src/lib/status.ts:29-34`). This is pinned as deliberate by
  `test/cli-commands.test.ts:519`, and the issue's "or" did not require it. Noted, not ranked.

## 5. Duplicated abstractions (#14)

**No fourth `ageMinutes` was added.** The count is unchanged at three:
`src/lib/status.ts:12-14`, `src/supervisor/tick.ts:22-24`, and the inline
`Math.floor((now - record.phase_entered_at) / MS_PER_MINUTE)` at `src/supervisor/stall.ts:70`. The
diff of `stall.ts` in #47 touches only `:153`, `:163`, `:195` and `:205` — `:70` predates it. The
`hpipe`-literal divergence #14 names (`status.ts:25` hardcodes `hpipe`, which a GitHub-installed
plugin cannot invoke — `src/lib/render.ts:28-38`) is untouched; #47's PR body says `status` and the
digest are deliberately left to #14, and the code matches that claim.

**#21's resolver did not duplicate run-selection inside itself**, but it also did not absorb the
spellings already beside it — see MINOR 4.

---

## Findings

### MINOR 1 — both PR bodies misreport their own suite numbers, in a repo where the PR body is the only evidence of record

CI here runs a title lint only (#35), so the PR body's measured counts are the whole verification
record. Neither matches the tree that merged.

- **#44** claims `bun test → 483 pass, 0 fail, 1156 expect() calls, 34 files` and "29 tests added,
  no new file." Measured at `2016ee0`: **488 pass**, i.e. **+34** over the 454 baseline it correctly
  cites. It also *did* add a file — `src/lib/repo.ts` (`git show 2016ee0 --stat -- src/lib/repo.ts`
  → `25 +++`), which the same body describes at length two sections earlier.
- **#47** claims `bun test → 504 pass / 0 fail, 34 files (488 before this change)`. The baseline is
  right; the result is **503**. The arithmetic confirms nothing is missing: #47 adds 13 tests to
  `test/stall.test.ts`, replaces 2 with 3 in `test/phases.test.ts` and adds 1 to
  `test/table.test.ts` → 488 + 15 = 503.

No test was lost and both merged trees are green, so this is a bookkeeping defect, not a coverage
defect. It is still worth ranking: the verification-before-completion discipline this repo runs on
is only as good as the numbers being read off real output, and two out of two PRs in this batch
transcribed them wrong in the same direction as "more than we actually proved" (#47) and "less than
we actually proved" (#44).

### MINOR 2 — `smoke.md` §4c's escalating list names eight of nine rows; `plan` is missing

`test/integration/smoke.md:365-367`:

> After `STALL_PROBE_MAX` (3) unanswered probes a row whose signal the probed actor produces itself
> (`research`, `spec`, the four review rows, `implement`, and the run's `branch-review`) is moved to
> `escalated`…

That enumerates 8 rows. The escalating set has 9 — `plan` is stallable with `signal: 'artifact'`
(`src/lib/phases.ts:99-100`) and escalates like `research` and `spec`. Measured:

```
escalating : branch-review, research, spec, spec-review, plan, plan-review,
             implement, pr-review-intent, pr-review-quality   (9)
probe-only : dispatch, execute, blocked-on-files, ci, merge, close, teardown,
             blocked-on-decision, escalated                    (9)
```

The sentence predates this batch and #19 did not make it false. It is ranked because the paragraph
immediately below it is the one #19 rewrote, and #19's new wording — "**Nine** rows are probed but
never escalated" (`:369`) — invites the reader to check the other side of a 9/9 partition against a
list that names eight. `smoke.md` was ruled to #19 for this batch precisely so the section would be
correct after the change; this is the one line in it that still is not.

While in that paragraph: `:377` closes §4c with "Nothing waits forever," four lines under a new
paragraph stating that nine rows wait forever by design. It reads as scoped to the deferral
mechanism described in its own sentence, so it is not ranked, but a reader arriving at §4c cold will
have to decide that for themselves.

### MINOR 3 — "not actionable" is spelled two ways: `resolveRun` says `terminal`, the supervisor says `releasesPane`, and a run parked in `escalated` falls in the gap

`resolveRun` refuses a run whose row is `terminal` (`src/lib/ledger.ts:145,178`) — that is `done`
alone. The supervisor's notion of "this run is not being driven" is `releasesPane`, used in both
`pickOneAdvance` (`src/supervisor/tick.ts:241`) and `taskStallCandidates`
(`src/supervisor/stall.ts:98`) — that is `done` **and** `escalated`
(`src/lib/phases.ts:70-72`).

Consequence, for a run parked at run-phase `escalated`:

- `hpipe decide --task tN` succeeds. `cmdDecide` filters on `allowTerminal: false` and on the
  task's own phase (`src/cli.ts:404-407,424-427`); neither excludes a run in `escalated`. It prints
  `opened decision dN on tN; task blocked-on-decision`.
- Nothing then carries the question anywhere. `announceDecisions` and `deliverPendingAnswers` run
  only inside `for (const run of advancing)` (`src/supervisor/main.ts:163,212-213`), and
  `advancing = pickOneAdvance(runs)` (`:147`) skips the run.
- **#19's new probes do not cover it either**: `blocked-on-decision` is stallable, but
  `taskStallCandidates` skips the whole run one line earlier (`src/supervisor/stall.ts:98`) —
  `taskCandidates=0`, measured in §1 above.

That is #38's failure mode (a question filed where no worker will ever read it) reproduced one phase
short of the guard built to stop it. Ranked MINOR rather than MAJOR on three counts: it is not a
regression — the pre-#44 `cmdDecide` had no filter of any kind (`git show 2016ee0^:src/cli.ts`,
`cmdDecide` at `:247-250` takes the first run holding the id); reaching the state needs a
*run*-level escalation, which only `dispatch`/`execute`/`branch-review` can produce; and it is loud
in `hpipe status`, which prints both `⚠ run escalated from <phase> … needs a human`
(`src/lib/status.ts:122-128`) and `⚠ tN blocked on an open decision`
(`:29-34`). Closing it is one predicate: `runRow(r.phase).releasesPane !== true` beside the
`terminal` test in `resolveRun`, for the commands that mutate.

### MINOR 4 — "one resolver" is four spellings of run selection

`resolveRun` is genuinely the single path for the six commands that *infer* a run, and that is the
claim #44 makes. Three other run-selection sites remain in the same two files and did not move:

- `activeRunForRepo` (`src/lib/ledger.ts:64-69`) — same repo filter, same terminal filter,
  **first-match instead of ambiguity failure**. Still used by `cmdStart` (`src/cli.ts:142`) and
  `src/actions/claim.ts:29`. Harmless where it is used — one match is enough to refuse a second
  `hpipe start` — but it is the exact function `resolveRun` was "modelled on", left sitting beside
  it with the semantics the batch existed to remove.
- Three inline `(await listRuns(ctx.stateDir, ctx.session)).find((r) => r.run_id === input.runId)`
  lookups — `cmdRewind` (`src/cli.ts:308`), `cmdAbort` (`:489`), `cmdResume` (`:501`). These
  duplicate `resolveRun`'s `runId` branch (`ledger.ts:159-171`) minus its `unreadable` handling, so
  the three commands most likely to be pointed at a corrupted run get `no such run: X` and nothing
  else, where `resolveFailure` would have printed `… is in <phase>, which is in no phase row`
  (`cli.ts:68-69`). Deliberate — `rewind`/`abort`/`resume` are in the `byIdOrNothing` deny-list
  (`:565`) — but it is duplication, and #14's ledger should carry it.

Separately, #19 added a **third** rendering of the escalated-task recovery sentence
(`src/supervisor/stall.ts:186-190`), alongside `src/supervisor/tick.ts:36-39` and
`src/lib/status.ts:22-26`. The new one is correct — it renders the injected `hpipe` — so this is a
net improvement over the clause it replaced (which told an escalated task it was waiting for an
answer to a decision it never asked). But it does widen the #14 surface by one site, and it makes
the `status.ts` copy's hardcoded literal `hpipe` the odd one out of three rather than two.

---

## What is sound, stated for the record

- The safety property #19 rests on is real and now pinned by tests that bite
  (`test/stall.test.ts`, `test/phases.test.ts`, `test/table.test.ts:79-84`). The `stallWhen` guard
  added in #19 step 1 fails loudly if a future task row is given a field `taskStallCandidates` does
  not read — a genuinely good trap.
- #21's failure messages name the session (`src/cli.ts:61`), which materially mitigates the
  separate known hazard that `hpipe` outside a herdr pane silently reads the `default` session's
  ledger.
- No schema change in either PR. `schema_version` stays 2, no `Run`/`Task` field added or removed,
  and `repo_key` keeps its pre-#44 value in a main checkout — so runs already on disk stay readable
  by the tag-pinned supervisor.
- The `close`-phase deadlock recorded in project memory is **not** live on the normal path: the
  unsatisfiable `closedAt > phase_entered_at` comparison was already replaced by
  `closedAtMs >= merged_at_ms` (`src/lib/machine.ts:178-182`). Only the rewind-into-`close`-from-
  before-`merge` path deadlocks, and that is exactly what #19's new `closed` clause tells the
  operator (`src/supervisor/stall.ts:253-266`).
- **Neither change has been observed live**, as #47's body says plainly. The unit suite is
  dependency-injected with fakes and this repo's own memory records it passing clean over two
  startup/gating Criticals. The post-release check that matters is the one #47 names: a task parked
  in `merge` past `STALL_PROBE_MAX` is probed and still does not escalate.

---

No blocker and no major. Four minors, none of which changes the shipped behaviour of either fix:
one bookkeeping defect in both PR bodies, one stale sentence in a runbook section, one
predicate that is narrower than its sibling in a rare and loudly-reported state, and duplication
that belongs to an already-open issue.

BLOCKERS: 0
MAJORS: 0
MINORS: 4

VERDICT: CLEAR
