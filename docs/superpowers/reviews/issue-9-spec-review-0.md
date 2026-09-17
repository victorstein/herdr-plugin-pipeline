# Adversarial review — spec for issue #9, pass 0

**Subject:** `docs/superpowers/specs/2026-09-17-issue-9-design.md`
**Against:** issue #9 (incl. its 2026-09-17 correction), `docs/superpowers/research/2026-09-17-issue-9-research.md`
**Worktree:** `/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-9-artifact-paths` @ `581d57d`
**Baseline re-verified:** `bun test` → `351 pass, 0 fail, 767 expect() calls, 33 files`

The spec's citations are, with the exceptions noted below, accurate: `src/cli.ts:88-92`,
`src/supervisor/tasks.ts:202-210`, `src/lib/predicates.ts:10-20,16,17-18`, `src/lib/phases.ts:92-93`
(`research` has no `onBlocker`), `src/supervisor/deliver.ts:90,93,97-101`,
`src/supervisor/main.ts:160-163,217,241,262-264`, `src/lib/config.ts:23,27,28,60`,
`src/startup.ts:104`, `src/lib/ledger.ts:29`, `test/cli-commands.test.ts:20-23,159-176`,
`test/tasks.test.ts:247-252,265-274` all check out. The declared file set matches the live ledger
exactly (`t1.files = ["src/cli.ts","src/lib/worker-prompt.ts","src/supervisor/tasks.ts","src/supervisor/deliver.ts","prompts/worker-brief.md"]`),
as does the #15 handoff (`t2.files = ["src/supervisor/stall.ts","src/supervisor/main.ts","prompts/stall-probe.md","src/lib/status.ts"]`,
and `gh issue view 15` now carries the "the probe cannot name the path" addendum claiming that fix).
The A1 quote is verbatim from `docs/superpowers/specs/2026-09-15-worker-owned-pipeline-design.md:444`.

The problem is not the evidence. It is that C2 — the one change the spec calls load-bearing — does
not fire in the one phase where failure was measured.

---

## BLOCKER 1 — `git worktree add` sets every file's mtime to checkout time, so in the `research` phase every pre-existing doc is "fresh" and C2's "exactly one" threshold never holds

**Claim.** §Data and control flow, lines 218-224, worked case for issue 38: *"Canonical
`docs/superpowers/research/2026-09-16-issue-38-research.md` does not exist. The scan finds exactly
one fresh `.md` under `docs/superpowers/*/`. It is adopted…"* — and §Architecture C2, lines 105-108:
candidates are entries "whose floored `mtimeMs` is greater than `phaseEnteredAt`".

**Problem.** In the `research` phase, `phase_entered_at` is stamped **at registration**, before the
worktree exists. `git worktree add` then writes every tracked file with a current mtime. So on the
first tick of `research`, *every* `.md` already under `docs/superpowers/*/` in the repo passes
`mtimeMs > phase_entered_at`. The count is not one; it is however many docs the repo has. Per
§Error handling row 3 and **A5**, two-or-more means **no adoption** — so C2 fails closed in exactly
the population that produced all three measured misfilings, and succeeds only in `spec`/`plan`,
where nothing was ever measured to fail (0/35, per the spec's own table at lines 23-26).

**Evidence.** This task is itself the instance.

Phase entry, from the live ledger
(`/Volumes/stein/.local/state/herdr/plugins/stein.pipeline/runs/pipeline/herdr-plugin-pipeline-20260917-bug-fixing-and-enhancements-qc13.json`,
`run.history[0]`):

    {'at': 1789617025426, 'task_id': 't1', 'from': 'queued', 'to': 'research', 'why': 'dispatched at registration'}

Worktree adoption, same ledger: `t1.adopted_at = 1789617141067`, i.e. the worktree was created
~115s **after** `research` was entered. That ordering is structural, not incidental:
`cmdTask` calls `enterTaskPhase(... taskRow('queued').onClear ...)` at `src/cli.ts:122` and only then
returns the brief that asks the orchestrator to create the worktree; the gate-open path does the same
at `src/supervisor/tasks.ts:140-147`. `applyEvents` sets `checkout_path`/`adopted_at` on
`worktree.created` and does **not** re-enter the phase (`src/supervisor/tick.ts:36-45`).

Resulting mtimes in this worktree:

    $ stat -f '%m %N' docs/superpowers/*/*.md
    1789617140 docs/superpowers/plans/2026-09-13-herdr-pipeline-plugin.md
    1789617140 docs/superpowers/plans/2026-09-15-worker-owned-pipeline.md
    1789617140 docs/superpowers/reviews/2026-09-13-design-adversarial-1.md
    ... (9 files at 1789617140)
    $ stat -f '%m %N' docs/superpowers/*/*.md | awk '$1==1789617140' | wc -l
           9

`1789617140000 > 1789617025426`, so **nine** pre-existing files would have been candidates alongside
the real note. Reproduced from first principles on a clean repo:

    $ git worktree add -q /tmp/mtimetest/wt -b wt   # repo files committed 2s earlier at …134
    $ stat -f '%m %N' /tmp/mtimetest/wt/docs/superpowers/*/*.md
    1789618136 …/notes/a.md
    1789618136 …/notes/b.md
    1789618136 …/specs/c.md

And berean-os, the repo the issue is about, carried **26** `.md` files under `docs/superpowers/*/`
before the run (`git ls-tree -r --name-only 305fe51a docs/superpowers/`). So on the motivating run
C2 would have found 27 candidates for issue 38, not one, and adopted nothing. The pipeline would
have stalled identically, and the hand-run `ls` the spec promises to eliminate would still have been
needed.

**Fix.** Raise the freshness baseline above worktree materialisation. `Task` already carries the
field: use `Math.max(task.phase_entered_at, task.adopted_at ?? 0)` as `phaseEnteredAt` for the
adoption scan only (`adopted_at` is stamped when the supervisor drains `worktree.created`,
`src/supervisor/tick.ts:41`, which is necessarily after `git worktree add` finished writing). Keep
`phase_entered_at` for the canonical `isFresh` check, which is filename-specific and unaffected.
Add a test that builds a **real** `git worktree` (not `mkdtempSync`) containing several pre-existing
`docs/superpowers/*/*.md` files and asserts adoption still happens — see MAJOR 1. State the new
assumption explicitly (adoption trusts `adopted_at`; a task with `adopted_at: null` gets no
adoption, which also disposes of MAJOR 3).

---

## MAJOR 1 — the test plan cannot detect BLOCKER 1, and the spec cites that fixture as the reason to trust it

**Claim.** §Testing strategy, lines 300-305: *"Modelled on `test/tasks.test.ts:240-274`, which
already builds a real worktree in a temp directory (`worktreeWith`…) and drives `advanceTasks`
against it — real filesystem, no injected fs fake. C2's whole subject is what is on disk, so faking
the filesystem would test the fake."*

**Problem.** `worktreeWith` is not a worktree. It is a bare `mkdtempSync` that creates **exactly one
file** (`test/tasks.test.ts:247-252`):

    function worktreeWith(relative: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'hpipe-design-'))
      mkdirSync(join(dir, dirname(relative)), { recursive: true })
      writeFileSync(join(dir, relative), 'findings\n')
      return dir
    }

Tests 1-7 built on it would all go green while production never adopts anything, because the single
precondition that breaks C2 — a tree full of freshly-checked-out docs — is absent from the fixture.
The spec's "real filesystem" argument is exactly the argument that makes this fixture look safe, and
it is the wrong one: the fake here is not `fs`, it is the *tree*.

**Fix.** Add a fixture that `git init`s a repo with ≥3 committed `docs/superpowers/*/*.md` files,
`git worktree add`s it, sets `phase_entered_at` before the `worktree add` and `adopted_at` after,
writes one extra note, and asserts adoption. Make it test #1; the current test #1 becomes a weaker
companion, not the primary evidence.

---

## MAJOR 2 — `claimed` is described as containing "every recorded verdict", but `task.artifacts.verdicts` is never written by any code path

**Claim.** §Data and control flow step 7, lines 208-210: *"`claimed` is every non-null path in
`task.artifacts` (the other two slots and every recorded verdict), so the research note cannot be
re-adopted as the spec."*

**Problem.** Nothing in `src/` ever assigns to `artifacts.verdicts`. It is read in two places and
written in none:

    $ grep -rn "artifacts.verdicts" src/ test/
    src/supervisor/deliver.ts:89:    return task.artifacts.verdicts[key]
    src/supervisor/deliver.ts:93:  return run.artifacts.verdicts[key] ?? join('docs/superpowers/reviews', …)
    test/deliver.test.ts:153:  run.artifacts.verdicts['branch-review-0'] = 'docs/superpowers/reviews/custom.md'

The live ledger confirms it stays empty through a full design cycle: `t1.artifacts.verdicts = {}`
after `research → spec → spec-review`. So the review files that land in
`docs/superpowers/reviews/` — which **is** inside C2's `docs/superpowers/*/` scan scope — are never
in `claimed`. The spec asserts a guard that does not exist.

Today this is latent rather than live (a verdict is written during `spec-review`, and the subsequent
`onBlocker` entry into `spec` re-stamps `phase_entered_at` after that write, so the verdict reads
stale). But once BLOCKER 1 is fixed by raising the baseline, the interaction has to be re-derived —
and a reviewer subagent that touches its verdict file after the phase turns over puts a review into
the candidate set for `spec`/`plan` with nothing excluding it.

**Fix.** Either (a) drop the false clause and exclude `docs/superpowers/reviews/` from the scan by
name, stating it as an assumption, or (b) keep the clause and make `artifactPathFor` persist the
computed verdict path into `task.artifacts.verdicts[key]` — but note that `deliver.ts` is in the
file set while the persistence would need a save-side owner, so (a) is the cheaper honest answer.
Either way, remove the parenthetical that claims a mechanism the code does not have.

---

## MAJOR 3 — with `checkout_path` null the scan runs against the **main checkout**, and C2 removes the filename specificity that made that fallback safe

**Claim.** §Error handling, line 237: *"`task.checkout_path` is null | scan base is `run.repo_root`,
matching `absoluteArtifactPath` (`src/supervisor/deliver.ts:100`)"* — presented as benign precedent.

**Problem.** The precedent does not transfer. Today, a null `checkout_path` makes the supervisor
stat `<repo_root>/docs/superpowers/research/<date>-issue-<n>-research.md` — a path no other task or
the orchestrator will ever create, so the worst case is a stall. C2 replaces that with "any `.md`
under `docs/superpowers/*/` newer than phase entry", in a directory shared by the orchestrator, the
run-level `branch-review` artifact, every review file, and every merge that lands another task's
docs. A single fresh file there is adopted as this task's artifact, written into the ledger
(`task.artifacts[slot]`), cited by `prompts/spec.md`'s `{{research_path}}` and by both reviewers,
and the phase advances on a file that belongs to something else. A5 argues waiting is recoverable
and a wrong adoption is not — this branch is precisely the wrong-adoption branch, and the spec
classifies it as a no-op.

The branch is reachable: the hook only populates `checkout_path` conditionally
(`src/hooks/_hook.ts:56`, `if (raw.worktree?.path) event.checkout_path = raw.worktree.path`), and
`applyEvents` stores `event.checkout_path ?? null` (`src/supervisor/tick.ts:40`), while `pane_id`
can arrive independently via the `workspace_id` match in `pane.agent_detected`
(`src/supervisor/tick.ts:49-67`). The `pane === null` guard at `src/supervisor/tasks.ts:153`
therefore does not exclude it.

**Fix.** Return `null` from `adoptableArtifact` when `task.checkout_path === null`. Adoption is a
worktree-scoped repair; it has no business in the main checkout. One line, and it also removes the
`adopted_at`-is-null edge introduced by BLOCKER 1's fix.

---

## MAJOR 4 — C3 trades away the only intervention with a measured 100% success rate, in exchange for a recovery that (per BLOCKER 1) does not happen in `research`

**Claim.** §C3, lines 176-182: *"After C2, 'stats those paths and nothing else' is false, and a
brief that is wrong about the mechanism is worse than one that is merely firm"*, replaced with
*"…the supervisor will recover it when it can, but recovery is a repair, not a second correct
answer."*

**Problem.** Two things go wrong at once.

First, the measured evidence points the other way. Issue #9: *"The three workers warned in advance
got it right first time."* Advance warning is 3/3; the brief's own firm wording is 3/6. C3 softens
the firm wording — telling the worker, in the same breath, that misfiling is recoverable — and the
spec offers no evidence that the softened text performs at least as well. §Testing strategy line 342
concedes this is unfalsifiable here, which is fine as a limitation but is not a licence to change
the text in the direction the evidence disfavours.

Second, the replacement is *itself* false in the `research` phase for as long as BLOCKER 1 stands:
the supervisor will **not** recover it. A brief that is wrong about the mechanism is worse than one
that is merely firm — the spec's own standard, applied to its own replacement.

**Fix.** Keep the current wording's firmness and correct only the factual clause. E.g. *"Write them
exactly as given, stem and all — do not re-derive them from the conventions you see in `docs/`. The
stem carries the issue number and every later phase cites the path by name. An artifact written
anywhere else does not complete the phase."* That is true before and after C2, and it does not
advertise a fallback to the agent the fallback exists to catch. If the wording is to be softened
anyway, say so as a labelled assumption with the 3/3-vs-3/6 numbers next to it.

---

## MAJOR 5 — the stated Goal is not met in the cases that matter, and the gap is handed to an issue whose scope does not cover it

**Claim.** §Goal, lines 55-57: *"The task either advances or its state changes visibly; it does not
sit at a stat that will never succeed."* §Non-goals, lines 64-72, hands the missing-artifact signal
to #15.

**Problem.** §Error handling rows 2 and 3 and §Data and control flow step 9 both resolve to
*"`base`, unchanged. Identical to today's behaviour"* — i.e. the task sits at a stat that will never
succeed, silently, which is the exact failure the Goal forbids and the exact failure issue #9 calls
*"the worst failure mode in the pipeline"*. Per BLOCKER 1 the two-or-more branch is the **normal**
branch in `research`, so post-C2 the common outcome is unchanged from today.

The handoff does not close it either. `gh issue view 15` scopes that issue to probe cadence,
backoff, escalation, dead-orchestrator detection, and (in its 2026-09-17 addendum) the task probe's
`artifact_path` substitution. Nothing there says "an idle worker in an artifact phase with no
artifact produces a signal." So the issue's second direction is owned by neither task. Meanwhile
`TASK_STALL_MINUTES` defaults to 45 (`src/lib/config.ts:27`) and the probe fires once ever per
phase entry (#15's body, `src/supervisor/stall.ts:62-64,83`) — so "visibly" in practice means one
probe, 45 minutes later, naming no path.

This one needs a human call, not an inline edit: either widen this spec's goal to include a signal
on the no-adoption branches (a log line plus a `hpipe status` marker would fit inside
`src/supervisor/tasks.ts`), or narrow the Goal to what C2 actually delivers and say plainly that
issue #9's second direction remains open.

**Fix.** Pick one and write it down. If narrowing, the Goal should read "a task whose worker misfiled
its artifact advances when the artifact is unambiguously identifiable" and §Non-goals should add
"a signal on the ambiguous and zero-candidate branches — remains open, tracked by \<new issue\>."

---

## MINOR 1 — C1 is a no-op in both repos for which evidence exists, and A3 concedes half of it

A2 defends C1 as "prevents zero measured failures, but stops the plugin writing a `research/`
directory into repos that keep notes elsewhere." A3 then states C1 is a no-op **here** (no `notes/`
in `docs/superpowers/`, confirmed: `plans`, `research`, `reviews`, `specs`). And in berean-os,
`research/` now exists — created by the run that motivated the issue — so C1's candidate order
(`['research','notes']`) makes it a no-op **there** as well, permanently. The directory-creation
harm C1 exists to prevent has already occurred in the only repo that ever suffered it. Net: C1 is
~15 lines plus two tests that change behaviour in no repo anyone has looked at.

**Fix.** Either drop C1 (A2 already notes "Dropping C1 does not weaken C2") or state in A2 that it
is forward-looking only and buys nothing in either known repo — as written, A2 overstates the value.

## MINOR 2 — the scan depth is one level exactly, and A4 does not say so

C2 line 105: *"reads `<checkoutRoot>/docs/superpowers/*/` — one level of subdirectory."* That
excludes `docs/superpowers/<file>.md` (depth 0) and anything nested deeper. A worker that writes
`docs/superpowers/issue-9-research.md` — a plausible misfiling, and arguably the most plausible one
for a repo with no obvious subdirectory — is not adopted. A4 argues only against scanning all of
`docs/` and against scanning only the canonical directory; it does not address depth 0.

**Fix.** Include depth-0 `.md` files directly under `docs/superpowers/` in the candidate set, or add
a sentence to A4 stating the exclusion and why.

---

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 5
