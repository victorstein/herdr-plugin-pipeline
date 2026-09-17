# Whole-branch adversarial review — issues #9 and #15 on `main`

**Tree under review:** `main` @ `ff99f40` (`chore(main): release 1.2.3 (#30)`), which contains
`f5c733d` (PR #27, issue #9) and `93f79b2` (PR #28, issue #15). The working checkout was two
commits behind at the start of this review and was fast-forwarded to `origin/main` before any
measurement below was taken.

## Verification, run here

```
$ bun test
 411 pass
 0 fail
 897 expect() calls
Ran 411 tests across 33 files. [8.47s]

$ bun run typecheck
$ tsc --noEmit
(exit 0, no output)
```

CI in this repo lints the PR title only (`.github/workflows/pr-title-lint.yml`), so neither PR's
green check was treated as evidence of anything.

---

## What was checked, and what came back clean

**The tick ordering is correct.** #9's adoption scan runs inside `advanceTasks`
(`src/supervisor/main.ts:177`) and #15's ladder runs at the end of the same tick
(`src/supervisor/main.ts:287-292`), so adoption always gets first refusal. When adoption succeeds,
`enterTaskPhase` re-stamps `phase_entered_at` (`src/lib/machine.ts:90-96`), `stallStateFor` rejects
the stamp mismatch (`src/supervisor/stall.ts:114-124`) and the record is not a candidate that tick.
Adoption therefore cannot fire for a record the ladder escalated in the same tick, and an escalated
task is inert to adoption thereafter (`gatherSignals` returns `null` for `escalated`,
`src/supervisor/tasks.ts:296-298`). The run-level `applyStalls` is awaited before
`taskStallCandidates` is even built (`main.ts:287-292`), so a run that escalates this tick has its
tasks skipped by the `releasesPane` guard (`stall.ts:97`) rather than escalated behind it.

**#9's three load-bearing claims still hold on the merged tree.**
`research`'s `phase_entered_at` is stamped at gate-open (`tasks.ts:148`) while `checkout_path` is
written later by the worktree hook (`src/supervisor/tick.ts:36-41`) — #15 changed neither. The
mtime argument is moot because the scan is a branch diff, not a stat. And `research` is still the
only phase whose path reaches the worker relative: `renderWorkerPrompt` passes
`task.artifacts.{research,spec,plan}` raw (`src/lib/worker-prompt.ts:23-25`) into
`worker-brief.md` and `research.md`, while every later phase renders absolute via
`taskArtifactPath` (`tasks.ts:57-59, 100-104`).

**#15's anchor claims hold too.** Every site that bypasses a phase transition re-stamps a
`phase_entered_at` that `stallStateFor` reads — `cmdRewind` task branch (`src/cli.ts:180`), run
branch (`:186`) and `cmdResume` (`:317`) — and because the state carries both `at` and `run_at`,
`cmdResume` re-arms every task ladder without walking `run.tasks`. I confirmed by execution that
an accepted probe climbs and escalates exactly at the cap: 3 probes, 1 escalation,
`phase='escalated'`, `escalated_from='implement'`.

**Prompts.** The declared set in `test/prompts.test.ts:10-14` is byte-identical to `ls prompts`
(21 files, `diff` empty). Every placeholder is supplied at every render site: I cross-checked all
18 `renderPrompt` call sites against the placeholder set of each template, and rendered
`worker-brief` + `research` through the real `renderWorkerPrompt` bag with no leftover `{{`.
`stall-probe` needs `{run_id, phase, minutes, awaiting, ladder}` and `main.ts:250-258` supplies
exactly those; `stall-escalate` needs `{run_id, phase, minutes, probes, awaiting_short, task_flag}`
and `main.ts:261-268` supplies exactly those; `hpipe` is injected centrally
(`src/lib/render.ts:46`).

**No duplicated abstraction was introduced across the two changesets.** #9 added one
spawn-degrading helper (`deliver.ts:121-132`) that follows the pattern already in `gh.ts:33-42` and
`herdr.ts:31-42`; #15 added none. The `join(task.checkout_path ?? run.repo_root, rel)` duplication
between `tasks.ts:100-104` and `deliver.ts:103-108` is pre-existing and is named as such in issue
#9's own correction; neither task created it.

**The deferrals to #23/#24/#25 are real, not assumed.** #9's zero-candidate branch is silent, and
the spec says so explicitly and argues for it (`docs/superpowers/specs/2026-09-17-issue-9-design.md:112-113`);
nothing merged depends on it logging. #15's ladder does not assume a reachable pane: `candidateFor`
returns `null` with no probe pane (`stall.ts:54-55`), `actorPaneFor` returns `null` for a paneless
worker so it escalates without consulting anyone (`stall.ts:46-48`), `agentStatus` degrades to
`'unknown'` on failure (`herdr.ts:70`) which does not defer, and `escalate` persists the transition
*before* attempting the send (`stall.ts:283-284`) so a dead orchestrator pane costs the announcement
and never the state change. That last ordering is exactly the constraint #24 records, and it was
honoured ahead of time.

`smoke.md` gained the operator documentation the spec promised (§4c at `:309-322`, recovery rows at
`:488-492`), and `status.ts` gained both escalation markers (`:21-27` task, `:122-128` run).

---

## MINOR 1 — the rewritten probe makes three claims the merged tree can falsify, one of which #9 deleted from the sibling prompt in this same batch

`stallAwaiting` builds the artifact/verdict clause unconditionally
(`src/supervisor/stall.ts:166-176`):

```ts
clause: `Nothing has appeared at:\n\n    ${path}\n\n` +
  'If you finished but wrote it elsewhere, move it exactly there — ' +
  'the supervisor stats that path and nothing else.',
```

#15's whole premise was that the probe's sentences must be true of what they name
(`test/prompts.test.ts:128-138` pins that the old template "asserted the value was a filesystem
path, which is false for seven of the nine signals"). Three instances survive:

**(a) "the supervisor stats that path and nothing else" is false after #27, and #27 deleted that
exact sentence.** `git show f5c733d -- prompts/worker-brief.md` removes:

> the supervisor stats those paths and nothing else, so an artifact written anywhere else is
> invisible and the phase never completes.

and replaces it with "An artifact written anywhere else does not satisfy this phase's contract",
precisely because `adoptableArtifacts` now also asks the branch (`deliver.ts:144-165`). #15's file
set was frozen before #27 landed, and the `origin/main` merge at `9d494cf` did not revisit the
sentence, so the claim #9 retired from the brief was reintroduced verbatim in the probe.

**(b) The path can name the main checkout for a task that has no worktree.**
`absoluteArtifactPath` falls back to `run.repo_root` when `checkout_path` is `null`
(`deliver.ts:103-108`). Executed against a task that was never dispatched:

```
candidate paneId = w1:p1 | actorPaneId = null
---- probe clause ----
Nothing has appeared at:

    /main-checkout/docs/superpowers/research/issue-9-research.md

If you finished but wrote it elsewhere, move it exactly there — the supervisor stats that path and
nothing else.
```

The recipient is the **orchestrator** (worker fallback, `stall.ts:14`), the real problem is "this
task was never dispatched", and the path named is in the orchestrator's own checkout. #9 identified
the identical hazard and guarded it — `adoptableArtifacts` returns `[]` on a null checkout
specifically so "the scan would [not] run against the main checkout"
(`deliver.ts:148-150`) — so one changeset solved this sub-problem and the other did not.

**(c) "Nothing has appeared at" is false on every `onBlocker` re-entry with a stale artifact.**
`gatherSignals` distinguishes stale from absent and refuses to adopt over a present-but-stale file
(`tasks.ts:239-243`); `stallAwaiting` performs no existence check at all. A task bounced back to
`spec` by a BLOCKER review that sits past `TASK_STALL_MINUTES` is told nothing has appeared at a
path where a file plainly exists.

All three are contained (the ladder escalates regardless) and none changes behaviour, which is why
this is MINOR. The fix for (b) and (c) is local to `stallAwaiting`; (a) is a one-sentence edit.

## MINOR 2 — the escalation guarantee is conditional on probe deliverability, and no open issue owns that condition

`applyStalls` climbs a rung only when the send is accepted (`stall.ts:245-250`):

```ts
if (c.action === 'probe') {
  if ((await deps.probe(c)).ok) {
    bumpStall(c.run, record, 'probes', deps.now())
    await deps.persist(c.run)
  }
  continue
}
```

Driven for 1000 ticks with `probe` returning `{ok:false}`:

```
sends = 1000 | stall = undefined | phase = implement
```

A record whose actor pane is non-`null` but unreachable is re-probed every `TICK_MS` (1000ms,
`config.ts:24`) forever and never reaches the cap. `probes` never increments, so the one thing #15
exists to deliver — "after N unanswered probes, escalate to a human" — does not happen in exactly
the class of failure the issue was filed about.

To be fair to the work: this is **not a regression**. The pre-#15 `sendProbes` gated identically
(`git show cdfb419:src/supervisor/stall.ts:97-103`), the behaviour is pinned by a deliberate test
(`test/stall.test.ts:431`), and the spec discloses it in its failure table with an owner
(`2026-09-17-issue-15-design.md:559`: *"No bump, no persist; `last_probe_at` unchanged, so still due
next tick — A6; Bounding this is #25"*). The gap is in the hand-off, not the disclosure: #24 owns
*stopping* sends to a dead pane and #25 owns *bounding* send volume, and #25 further specifies that
the budget must gate "the prompt, not the state transition". Neither issue says an **undeliverable
probe must still climb the ladder**, so a faithful implementation of both would leave an
unreachable worker un-escalated. Worth one sentence on #24 or #25 rather than a code change here.

## MINOR 3 — coordination scaffolding left behind now that the file lock is gone

Two compromises in #9 were justified solely by `src/supervisor/main.ts` and `src/supervisor/stall.ts`
being held by #15. #15 has landed; neither is tracked.

- `src/supervisor/tasks.ts:184-189` cites symbols that no longer exist: *"Keyed the same way
  `taskStallKey` keys `alreadyProbed`"*. #15 deleted both (`41e79ed`, "drop the transitional stall
  candidate key"); `grep -rn "taskStallKey\|alreadyProbed\|sendProbes" src/ test/` now returns only
  this comment.
- `TaskDeps.ambiguityLog?` plus the module-level `defaultAmbiguityLog` (`tasks.ts:36-38, 189, 257`)
  is a second cross-tick dedup mechanism alongside `main()`'s own. PR #27's quality review raised
  this as a MAJOR and #27 fixed only half of it, stating plainly that *"the prescribed other half —
  make the field required and declare it in `main()` — edits `src/supervisor/main.ts`, which is
  issue #15's file… Making it required is a clean follow-up once #15 lands."* That condition is now
  satisfied and there is no issue for it.

## MINOR 4 — the three-dot-diff invariant has a demonstrated counter-case when the branch merges `main`

`2026-09-17-issue-9-design.md:186-187` rests the scan on:

> `main...HEAD` diffs from the merge-base, so it names what *this branch* added and is unaffected by
> siblings merging into `main` mid-run.

True while the branch never merges `main`. It stops being true when the branch merges
`origin/main` while the worktree's local `main` ref is behind — the merge-base stays at the old
`main`, and every doc that landed on `origin/main` in between becomes an "added" path. This
repo's own `fix/15-stall-escalation` did exactly that at `9d494cf`, and #15's spec mandates the
merge as a pre-PR gate. Reproduced against the real commits, with local `main` at `6008bce`:

```
$ git diff --name-only --diff-filter=A 6008bce...9d494cf -- docs/ | grep -v '^docs/superpowers/reviews/'
docs/superpowers/plans/2026-09-17-issue-15-plan.md
docs/superpowers/plans/2026-09-17-issue-9-plan.md
docs/superpowers/research/2026-09-17-issue-15-research.md
docs/superpowers/research/2026-09-17-issue-9-research.md
docs/superpowers/specs/2026-09-17-issue-15-design.md
docs/superpowers/specs/2026-09-17-issue-9-design.md
```

Six sibling-owned candidates that the invariant says cannot appear. Here that fails closed
(`candidates.length > 1` adopts nothing and logs, `tasks.ts:254-260`), which is the right default.
The unrecoverable case — spec **A5**'s wrong adoption — needs the window to contain exactly one
non-review doc while this task has written none of its own, which is narrow, and in practice the
`main` merge happens at `implement` time, after every adoption-eligible phase. So: narrow, but the
invariant as written is stronger than the code earns. Pinning the base to the branch's own fork
point, or refusing to scan a branch with a merge commit since fork, would restore it.

---

## Ranking

No BLOCKERs and no MAJORs. The seam between the two changesets is genuinely clean: the ordering
inside the tick is correct, the ladder's self-invalidating stamp composes with adoption's phase
advance without either knowing about the other, the deferrals to #23/#24/#25 are argued rather than
assumed, and both specs' load-bearing claims survive re-verification against the merged tree rather
than against either branch alone. The four findings above are a false sentence in a prompt, an
unowned edge in a hand-off, two stale coordination artifacts, and an overstated invariant — none of
them changes what the supervisor does on a healthy run.

MINORS: 4

VERDICT: CLEAR
