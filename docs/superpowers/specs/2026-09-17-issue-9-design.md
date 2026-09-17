# Artifact path resolution — design (#9)

**Date:** 2026-09-17
**Issue:** #9 — hardcoded artifact paths make workers write artifacts the supervisor never sees
**Research:** `docs/superpowers/research/2026-09-17-issue-9-research.md` (commit `417684d`)
**Status:** Design v3. Pass 0 (`VERDICT: BLOCKER`, 1 blocker / 5 majors / 2 minors) and pass 1
(`VERDICT: CLEAR`, 3 majors / 2 minors) both fully applied.
Reviews: `docs/superpowers/reviews/issue-9-spec-review-{0,1}.md`.
**Files this task owns** (`t1.files` in the run ledger): `src/cli.ts`, `src/lib/worker-prompt.ts`,
`src/supervisor/tasks.ts`, `src/supervisor/deliver.ts`, `prompts/worker-brief.md`.

> **Review history — pass 0 found the design's load-bearing change did not fire.**
>
> v1 detected a misfiled artifact by scanning `docs/superpowers/*/` for files whose mtime was newer
> than `phase_entered_at`. BLOCKER 1 established that `git worktree add` stamps every checked-out
> file with the current mtime, while `research`'s `phase_entered_at` is set at *registration*,
> before the worktree exists. Confirmed independently against the live ledger: `research` entered at
> `1789617025426`, and all nine pre-existing `docs/superpowers/*/*.md` files in this worktree carry
> mtime `1789617140000`. Every one of them read as fresh. v1's worked example — *"the scan finds
> exactly one fresh `.md`"* — was false; in berean-os it would have found 27 candidates for issue 38
> and adopted nothing, in exactly the phase where all three failures were measured.
>
> **v2 does not repair the mtime scan. It removes mtime from the mechanism.** Candidates now come
> from `git diff --diff-filter=A <base>...HEAD -- docs/`, which is a question about branch content
> and carries no timestamp at all. See §Rejected alternatives for why the review's own proposed fix
> (`max(phase_entered_at, adopted_at)`) was verified and then not taken.
>
> The failure v1 made is worth naming, because it is the one this repo's design history records
> repeatedly: **it reasoned about the artifact from the supervisor's clock instead of from the
> thing the artifact actually is — a commit on a branch.** Every timestamp-derived fix for this
> class has a next edge case; the branch-content question has none.

> **Pass 1 returned `CLEAR` and audited every pass-0 disposition as genuine.** Its three MAJORs
> were all internal-consistency defects in v2's own new text, and all three are applied below. The
> sharpest — and the one worth naming, because it is the *same class of error as v1's blocker* — is
> that v2 gated adoption on `!isFresh` while its own §Problem stated two paragraphs earlier that
> `isFresh` cannot distinguish missing from stale. v1 reasoned about the artifact from the clock;
> v2 removed the clock from the mechanism but left it in the *gate*. v3 gates on absence.
>
> The second is the one fix in v2 that was adopted from pass 0 rather than re-derived: the brief's
> replacement sentence was shipped along with pass 0's assertion that it was true, and it was not.
> A review's proposed wording is a proposal, not a verified fact — the same standard v2 applied when
> it declined pass 0's `max(phase_entered_at, adopted_at)` fix now applies to its wording fix.

## What changed from v2, by pass-1 finding

| Finding | Disposition |
|---|---|
| **MAJOR 1** — adoption gated on `!isFresh`, so it fires on present-but-stale artifacts (every `onBlocker` re-entry) | **Accepted.** Gate is now absence. §C1 wiring, **A5**, tests T11 |
| **MAJOR 2** — C2's replacement sentence still falsified by C1; spec asserted twice that it was not | **Accepted.** Sentence changed to a true one; the truth-claim deleted; **A10** rewritten to own the choice |
| **MAJOR 3** — `console.error` trigger specified three ways; §C1's version fires every tick; contradicts A1 | **Accepted.** Post-filter ≥2 only, deduped per phase entry. **A13**, §flow step 6, test T3 |
| **MINOR 1** — `git diff` consumed as machine data with no `quotePath`/rename pinning | **Accepted, with one correction.** `-z` alone subsumes `core.quotePath` (verified); only `diff.renames=true` needs pinning. **A12**, tests T12-T13 |
| **MINOR 2** — test files sit outside the declared `t1.files` | **Accepted.** Named explicitly under §Testing strategy |

## What changed from v1, by finding

| Finding | Disposition |
|---|---|
| **BLOCKER 1** — worktree mtimes make every doc "fresh" in `research` | **Accepted.** Mechanism replaced: git branch-diff, not mtime. §C1 |
| **MAJOR 1** — `worktreeWith` is a `mkdtempSync` with one file; tests cannot detect BLOCKER 1 | **Accepted.** Primary fixture is now a real `git init` + `git worktree add`. §Testing T1 |
| **MAJOR 2** — `claimed` claims to exclude verdicts, but nothing writes `artifacts.verdicts` | **Accepted.** False clause removed; `docs/superpowers/reviews/` excluded by name. **A6** |
| **MAJOR 3** — null `checkout_path` points the scan at the shared main checkout | **Accepted.** `adoptableArtifact` returns `null` when `checkout_path` is null. **A7** |
| **MAJOR 4** — C3 softened the only intervention with a measured 3/3 record | **Accepted.** Firmness kept; only the false clause corrected. The `./` prefix is dropped. §C2, **A10** |
| **MAJOR 5** — Goal unmet on the no-adoption branches; gap owned by neither issue | **Accepted, resolved without a human call.** Goal narrowed to what the design delivers; a log line added on the no-adoption branch; the human-visible signal declared open with a recommended follow-up. **A9** |
| **MINOR 1** — C1 (directory derivation) is a no-op in both known repos | **Accepted. Dropped entirely.** **A11** |
| **MINOR 2** — depth-0 files under `docs/superpowers/` are excluded | **Dissolved.** A branch diff is depth-independent; the scope is now `docs/`. |

---

## Problem

The supervisor stats exactly one plugin-chosen path per artifact phase
(`src/supervisor/tasks.ts:202-210`). The worker chooses where it writes. When the two disagree the
task sits in its phase forever: `isFresh` is a `statSync` in a `try` that returns `false` on throw
(`src/lib/predicates.ts:10-20`), so a missing file is indistinguishable from a stale one, and
`gatherSignals` returns `base` unchanged with nothing logged.

Measured on the berean-os run of 2026-09-16 (research note §Evidence):

| Delivery form | Artifacts produced | Misfiled |
|---|---|---|
| Absolute path (`spec`, `plan`, all review rows) | 35 | **0** |
| Relative path (`research`) | 6 | **3** |

`research` is the only phase whose path reaches the worker as a bare relative string, once, embedded
in a long brief (`src/lib/worker-prompt.ts:23-25`); every other phase's arrives absolute via
`promptForTaskPhase` (`src/supervisor/tasks.ts:47,92-95`). The asymmetry is structural:
`promptForTaskPhase` is only reached after `advanceTask` changes the phase
(`src/supervisor/tasks.ts:165-167`), the `queued → research` transition `continue`s instead
(`src/supervisor/tasks.ts:135-146`), and `research` has no `onBlocker` (`src/lib/phases.ts:92-93`)
so no task re-enters it.

**The issue's first direction does not work, and the research note proved it.** All three workers
mirrored berean-os's convention in *both* directory and filename —
`notes/2026-09-16-atomic-store-saves.md`, `notes/bookmark-save-reachability.md`,
`notes/qr-display-removal.md`. That repo's naming is `<date>-<slug>.md`; no file in it ever used an
`issue-<n>` stem. Resolving only the directory would have made the supervisor stat
`notes/…-issue-27-research.md` and still find nothing. And *"the directory does not exist"* is not
the cause either: `docs/superpowers/reviews/` also did not exist before that run and is hardcoded
identically (`src/supervisor/deliver.ts:90,93`); 23 review files landed in it with zero renames.

The defect is that **the plugin's choice of path is only ever requested in prose, never enforced,
and a worker that declines is met with silence.**

## Goal

*(Narrowed from v1 per MAJOR 5.)* A task whose worker wrote its artifact somewhere other than the
path the plugin named **advances anyway, whenever the branch identifies exactly one candidate** —
which, verified below, is all three of the measured failures. On the branches where it cannot, the
supervisor **logs why** rather than returning silently.

This does not make every silent stall visible; see §Non-goals.

## Non-goals

- **A human-visible signal on the no-adoption branches.** v1 claimed the Goal covered this and
  MAJOR 5 was right that it did not. `console.error` from the supervisor loop (§C1) is a log line,
  not something the human or the orchestrator sees. Issue #15's scope — probe cadence, backoff,
  escalation, dead-orchestrator detection, and (per its 2026-09-17 addendum) the task probe's
  `artifact_path` substitution — does not cover it either. It was owned by neither issue.
  **It is now issue #23**, *"An idle worker in an artifact phase with no identifiable artifact
  produces no signal"*, which owns making "the artifact is absent" a distinct, reportable state in
  `hpipe status` and the digest. Filed by the orchestrator on 2026-09-17 under the scope ruling
  recorded on issue #9 — which narrows #9 to adoption-plus-log and separates the signal because a
  complete one spans two tasks' file sets: detection in `src/supervisor/tasks.ts` (this task's)
  and the marker in `src/lib/status.ts` (#15's).
- **Stall probe cadence and escalation** — issue #15, task `t2`, which owns
  `src/supervisor/stall.ts`, `src/supervisor/main.ts`, `prompts/stall-probe.md`,
  `src/lib/status.ts`.
- **The task stall probe's missing path.** `src/supervisor/main.ts:262-264` renders the literal
  phrase `whatever clears research for <branch>` into `{{artifact_path}}` while the run-level probe
  at `src/supervisor/main.ts:241` calls `absoluteArtifactPath`. Real defect, one-line fix, `t2`'s
  file. Handed to #15 in v1; **#15 has since claimed it** (its 2026-09-17 addendum).
- **The `reviews` stem** (`src/supervisor/deliver.ts:90,93`). 23/23 landed correctly. No harm to buy.
- **Deriving the artifact directory from the repo** — dropped, see **A11**.
- **A per-repo config file.** Nothing in `src/` reads config from `run.repo_root`; `loadConfig`
  reads `config.env` from `HERDR_PLUGIN_CONFIG_DIR` (`src/lib/config.ts:60`, `src/startup.ts:104`).
  New mechanism, not an extension of one.
- **Changing the phase machine or the `Task` shape.** `src/lib/phases.ts`, `src/lib/types.ts`,
  `src/lib/machine.ts` are outside this task's file set.

---

## Architecture

One change carries the design; one is a prompt correction.

### C1 (load-bearing) — adopt the artifact the branch says the worker added

New in `src/supervisor/deliver.ts`, beside the artifact-path resolution it already owns
(`artifactPathFor`, `absoluteArtifactPath`, lines 84-101):

```ts
/**
 * The worker was given one path and wrote another — 3 of 6 research notes on the
 * berean-os run of 2026-09-16, all three mirroring the repo's own naming instead
 * of the brief's. Ask the branch what it added rather than the filesystem what is
 * recent: `git worktree add` stamps every checked-out file with the current mtime,
 * and `research`'s phase_entered_at predates the worktree, so no mtime comparison
 * distinguishes the worker's note from the whole repo's docs.
 */
export async function adoptableArtifact(
  checkoutPath: string | null, claimed: Set<string>,
): Promise<string | null>
```

1. `checkoutPath === null` → `null`. Adoption is a worktree-scoped repair (**A7**).
2. `git -C <checkoutPath> rev-parse --verify --quiet main` non-zero → `null` (**A3**).
3. `git -c diff.renames=true -C <checkoutPath> diff -z --name-only --diff-filter=A main...HEAD
   -- docs/`, split on `NUL`. **A12** covers both flags.
4. Drop any path under `docs/superpowers/reviews/` (**A6**).
5. Drop any path in `claimed`.
6. Exactly one survivor → return it (a repo-relative path, which is what `task.artifacts` stores).
   Otherwise `null`.

Subprocess handling mirrors `src/lib/gh.ts:30-42` — `Bun.spawn` wrapped in `try`, a failure
degrading to a non-ok result rather than throwing, because *"callers rely on these methods never
throwing"* and this one runs inside the supervisor tick. `git` is already spawned this way at
`src/cli.ts:346` and `src/actions/claim.ts:14`.

**Why a three-dot diff.** `main...HEAD` diffs from the merge-base, so it names what *this branch*
added and is unaffected by siblings merging into `main` mid-run. It carries no timestamp, so the
whole BLOCKER 1 class — worktree checkout mtimes, a mid-phase `git checkout`, a `touch` — cannot
reach it.

Verified in this worktree:

    $ git rev-parse --verify main
    6008bcef9f8c762571aeb4dffa51d0a21199f7f1
    $ git diff --name-only --diff-filter=A main...HEAD -- docs/
    docs/superpowers/research/2026-09-17-issue-9-research.md
    docs/superpowers/reviews/issue-9-spec-review-0.md
    docs/superpowers/specs/2026-09-17-issue-9-design.md
    $ touch docs/superpowers/specs/2026-09-13-herdr-pipeline-plugin-design.md
    $ git diff --name-only --diff-filter=A main...HEAD -- docs/
    docs/superpowers/research/2026-09-17-issue-9-research.md
    docs/superpowers/reviews/issue-9-spec-review-0.md
    docs/superpowers/specs/2026-09-17-issue-9-design.md

Touching a pre-existing file changes nothing — the direct refutation of BLOCKER 1's failure mode,
where that same file became a candidate.

**Verified against all three real failures** (berean-os, at each worker's research commit):

    $ git diff --name-only --diff-filter=A main...f9085346 -- docs/   # issue 38
    docs/superpowers/notes/qr-display-removal.md
    $ git diff --name-only --diff-filter=A main...89147007 -- docs/   # issue 27
    docs/superpowers/notes/2026-09-16-atomic-store-saves.md
    $ git diff --name-only --diff-filter=A main...0c829e58 -- docs/   # issue 28
    docs/superpowers/notes/bookmark-save-reachability.md

Exactly one candidate in each case. All three would have been adopted; all three
`docs: move … to the path the supervisor stats` commits, and the hand-run `ls` that found them,
would not have happened.

*(These transcripts predate **A12** and omit `-z` and `-c diff.renames=true`. Neither changes the
result here: `diff.renames=true` is git's default, and `-z` alters only output framing, not which
paths are selected. They are left as run.)*

**Wiring**, in `gatherSignals` (`src/supervisor/tasks.ts:202-210`), which today reads:

```ts
    case 'research':
    case 'spec':
    case 'plan': {
      if (!actorIdle) return base
      const absolute = absoluteArtifactPath(run, task)
      if (absolute === null) return base
      if (!(await isFresh(absolute, task.phase_entered_at))) return base
      if (!(await isSettled(absolute, deps.fileSettleMs))) return base
      return { ...base, artifactFresh: true }
    }
```

The `if (!actorIdle) return base` guard stays first and is load-bearing for cost. **Adoption is
then gated on the canonical path being *absent*, not on `!isFresh`** — the two are not the same, and
conflating them is what pass 1's MAJOR 1 caught. `isFresh` is `statSync(...).mtimeMs > phaseEnteredAt`
in a `try` (`src/lib/predicates.ts:10-20`), so it is false for a *stale* file exactly as much as for
a missing one, which §Problem already says. Every `onBlocker` re-entry produces a stale canonical
artifact: `spec-review` returns to `spec` and `plan-review` to `plan`
(`src/lib/phases.ts:97,102-103`), and `enterTaskPhase` re-stamps `task.phase_entered_at`
(`src/lib/machine.ts:94`). Gating on `!isFresh` would therefore run the scan through every revision
loop and could adopt a stray committed doc over an `artifacts.spec` that was already correct —
A5's unrecoverable branch, through a door the design means to keep shut. So:

```ts
      if (!(await isFresh(absolute, task.phase_entered_at))) {
        if (existsSync(absolute)) return base          // stale, not missing — never adopt
        // …adoption path…
      }
```

On a hit, the path is written to `task.artifacts[slot]` and the phase advances. On a miss with **two
or more survivors after filtering**, one `console.error` naming the task, the slot and the
candidates — deduplicated per phase entry (**A13**).

**Adoption is recorded, not merely accepted.** `task.artifacts[slot]` is mutated and the caller
saves the run (`src/supervisor/main.ts:217`), so every later citation resolves to the real file:
`prompts/spec.md`'s `{{research_path}}`, the reviewer's brief in `prompts/spec-review.md`, and
`taskArtifactPath` (`src/supervisor/tasks.ts:92-95`). It is also what makes adoption idempotent —
the next tick's canonical stat hits the adopted path and the fallback never runs again for that
slot — and it is why no new `Task` field is needed, which is what keeps this inside the file set.

### C2 — stop the brief from making a claim C1 falsifies, without softening it

`prompts/worker-brief.md` currently ends its path list with:

> Those paths are relative to this worktree, which is your cwd. Write to them exactly as given: the
> supervisor stats those paths and nothing else, so an artifact written anywhere else is invisible
> and the phase never completes.

After C1 *"stats those paths and nothing else"* is false. v1 replaced it with wording that told the
worker recovery exists; MAJOR 4 was right that this trades away the only intervention with a
measured 100% record (issue #9: *"The three workers warned in advance got it right first time"* —
3/3, against the brief's own 3/6) in exchange for advertising a fallback to the agent the fallback
exists to catch. v2 keeps the firmness and corrects only the false clause:

> Those paths are relative to this worktree, which is your cwd. Write them exactly as given, stem
> and all — do not re-derive them from the conventions you see in `docs/`. The stem carries the
> issue number, and every later phase cites the path by name. An artifact written anywhere else
> does not satisfy this phase's contract.

**A10** owns why this is the right sentence — and why v1's "does not complete the phase", which pass
0 proposed and v1 shipped unexamined, was not.

`src/lib/worker-prompt.ts` is unchanged in v2: the `./` prefix v1 proposed is dropped, as A7 of v1
predicted it would be.

---

## Data and control flow

**Registration** — unchanged from today in every respect. `task.artifacts` is built from the
hardcoded stems (`src/cli.ts:88-92`) with `checkout_path: null` (`src/cli.ts:87`); the task moves
`queued → research` and the brief is rendered and returned (`src/cli.ts:122-126`), **[C2]** with the
corrected wording.

**Execution** — per tick, per task, in `gatherSignals`.

1. Row is `research`/`spec`/`plan`. Actor not idle → `base`. *(No git call.)*
2. Canonical absolute path fresh and settled → `artifactFresh: true`. *(No git call. Happy path
   unchanged.)*
3. **[C1]** Canonical path not fresh **and not present** → `adoptableArtifact(task.checkout_path,
   claimed)`, where `claimed` is every non-null path in `task.artifacts.{research,spec,plan}`.
   *(Not verdicts — see **A6**.)* Present-but-stale → `base`, no scan (**A5**).
4. Exactly one survivor, and it passes `isSettled` → `task.artifacts[slot] = candidate`, return
   `artifactFresh: true`.
5. Zero survivors → `base`. Identical to today.
6. Two or more survivors **after filtering** → `base`, **plus** one `console.error` naming the
   task, the slot and the candidates, at most once per phase entry (**A13**). The count that matters
   is post-filter: the *raw* `git diff` list is never empty in `spec` or `plan`, because the research
   note is always an added path on the branch, so logging on a non-empty raw list would fire every
   tick of every spec and plan phase.
7. `advanceTask` advances the row; `promptForTaskPhase` renders the next prompt from the **adopted**
   value (`src/supervisor/tasks.ts:92-95`); `src/supervisor/main.ts:217` saves the run.

Worked case, issue 38 on the berean-os run: worker writes
`docs/superpowers/notes/qr-display-removal.md`, commits, pushes, goes idle. Canonical
`docs/superpowers/research/2026-09-16-issue-38-research.md` does not exist. The branch diff returns
exactly that one path (verified above). It is adopted, `task.artifacts.research` becomes it, the
task advances to `spec`, and `prompts/spec.md` tells the worker to build on that file by its real
name.

---

## Error handling

| Condition | Behaviour | Precedent |
|---|---|---|
| `git` missing, or spawn throws | catch → `null` → today's behaviour | `src/lib/gh.ts:30-42` |
| `git diff` exits non-zero | `null` | `src/lib/gh.ts:44-46` (`okCodes`) |
| `main` does not resolve in the worktree | `null` (**A3**) | — |
| `checkout_path` is null | `null` (**A7**) | — |
| Canonical path present but stale | no adoption, keep waiting | **A5**; every `onBlocker` re-entry |
| Zero candidates | no adoption, keep waiting | today's behaviour |
| Two or more candidates after filtering | **no adoption**, keep waiting, one log line per phase entry | fail closed; **A5**, **A13** |
| A pre-existing doc was `git mv`d on the branch | not a candidate, provided rename detection is on | **A12** |
| Adopted file deleted later | next tick's canonical stat fails, fallback re-runs | adoption is a value, not a latch |
| Worker has not committed | not a candidate (**A4**) | — |

`isSettled` sleeps `FILE_SETTLE_MS` (default 750ms, `src/lib/config.ts:28`) per call
(`src/lib/predicates.ts:27-35`), so it is called on the **single survivor only**, never per
candidate.

---

## Assumptions

**A1 — Adopting the worker's path beats refusing it.** The alternative is to keep the plugin's path
authoritative and report loudly. Reporting needs per-phase-entry dedup state to avoid re-prompting
on a 1s tick (`src/lib/config.ts:23`); that state is a new `Task` field and `src/lib/types.ts` is
outside the file set. Adoption is self-deduplicating because it makes the canonical path correct.
*This partially reverses `docs/superpowers/specs/2026-09-15-worker-owned-pipeline-design.md:444` —
"paths rendered by the plugin and never chosen by the worker".* That principle exists so the
freshness predicate knows where to look, and C1 preserves exactly that by writing the discovered
path into the ledger before anything else reads it. Still the most attackable decision here.

**A2 — Branch content, not filesystem time, is the right question (new in v2, replaces v1's core).**
An artifact is a commit on a branch; `worker-brief.md` §Definition of done requires commit and push
in every phase without exception. Every timestamp-derived variant of this design has an edge case
(§Rejected alternatives documents two, one of them the review's own proposal); the branch-diff
question has none, as the `touch` test above demonstrates.

**A3 — `main` is the base branch.** `prompts/dispatch.md` mandates
`herdr worktree create --cwd {{repo_root}} --branch <branch> --base main`, and
`prompts/worker-brief.md` says *"Never commit to `main`"*. A repo whose base is not `main` gets no
adoption and today's behaviour, which is a degradation, not a regression. Storing the real base
would need a `Run`/`Task` field (`src/lib/types.ts`, outside the file set).

**A4 — Requiring a commit is correct, not merely convenient.** Git cannot see an uncommitted file,
so a worker who wrote the note and never committed gets no adoption. That is the behaviour the brief
already demands (*"a phase completes when its file is on the branch, not when you feel finished"*),
and all three measured failures had committed — which is why the corrective renames exist to be
read. The canonical `isFresh` check still fires on an uncommitted file at the right path, so the
happy path is not made stricter.

**A5 — "Exactly one" is the right threshold, and adoption requires the canonical path to be
*absent*.** Two candidates means the supervisor cannot tell which is the artifact; guessing advances
the phase on the wrong file and propagates it into the spec, both reviews and the PR. Waiting is
recoverable; a wrong adoption is not. The same logic forces the absence gate rather than an
`!isFresh` gate: on every `onBlocker` re-entry the canonical artifact is present and instantly stale
(`src/lib/phases.ts:97,102-103`, `src/lib/machine.ts:94`), and a design that scanned then could
replace a correct `artifacts.spec` with a stray doc the worker happened to commit while revising.
The cost of the absence gate is a real miss: a worker who, on re-entry, writes the revised spec to a
*different* path gets no adoption and stalls as today. Fail-closed, deliberately.

**A6 — `docs/superpowers/reviews/` is excluded by name, not by `claimed`.** v1 said `claimed`
contained "every recorded verdict"; MAJOR 2 established that nothing in `src/` ever writes
`artifacts.verdicts` — it is read at `src/supervisor/deliver.ts:89,93` and written nowhere, and the
live ledger shows `t1.artifacts.verdicts = {}` after a full `research → spec → spec-review` cycle.
A verdict file *is* added on the branch under `docs/`, so without this exclusion it would be a
candidate. Excluding the directory by name is the cheap honest fix; making `artifactPathFor` persist
verdict paths would need a save-side owner outside the file set.

**A7 — Adoption requires `checkout_path`.** Per MAJOR 3, a null `checkout_path` would point the
scan at the main checkout, shared with the orchestrator, the run-level `branch-review` artifact and
every sibling's merged docs — the wrong-adoption branch A5 calls unrecoverable. The branch is
reachable: `src/hooks/_hook.ts:56` sets `checkout_path` only `if (raw.worktree?.path)`, and
`src/supervisor/tick.ts:40` stores `event.checkout_path ?? null`, while `pane_id` can arrive
independently (`src/supervisor/tick.ts:58-67`), so the `pane === null` guard at
`src/supervisor/tasks.ts:153` does not exclude it.

**A8 — The stem stays `<date>-issue-<n>-*`** (`src/cli.ts:76-77`). It carries the issue number,
which is what keeps two tasks in one repo from colliding
(`docs/superpowers/specs/2026-09-15-worker-owned-pipeline-design.md` §Artifacts). C1 makes a stem
mismatch survivable, so there is no reason to trade the guarantee away.

**A9 — The Goal is narrowed rather than widened (MAJOR 5).** The review offered both; this takes
narrowing plus a `console.error`, because the human-visible surface is `hpipe status`
(`src/lib/status.ts`) and the probe (`src/supervisor/main.ts`), both `t2`'s files. Widening would
mean either reaching into them or inventing a third surface. The log line is honest but small; the
gap is recorded in §Non-goals rather than left implied.

*Settled.* The scope ruling on issue #9 (2026-09-17) takes the same half — "narrow this issue, open
a new one" — and records that this assumption reached it independently before the ruling was
written down. The remainder is issue #23.

**A10 — The brief states the contract, not the mechanism.** Advance warning scored 3/3 against the
brief's 3/6, so the firm register stays (pass 0's MAJOR 4). But pass 1's MAJOR 2 was right that v1's
replacement — *"does not complete the phase"* — is falsified by C1 in precisely the population C1
exists for, in the same way and for the same reason as the clause it replaced; v1 carried pass 0's
proposed wording and its truth-claim across without re-deriving either, the one fix in v2 that was
adopted rather than verified. *"Does not satisfy this phase's contract"* is true whether or not
adoption fires: the contract is the named path, and adoption is a repair the supervisor may attempt,
not a second correct answer. The brief deliberately does not mention that repair, because
advertising the fallback to the agent the fallback exists to catch is exactly what MAJOR 4 forbade.

**A11 — Directory derivation is dropped entirely (MINOR 1).** v1's C1 resolved the artifact
directory from the repo's layout. It prevents zero measured failures (the filenames deviated too);
it is a no-op in this repo, which has no `notes/` under `docs/superpowers/`; and it is a permanent
no-op in berean-os, where `research/` now exists — created by the very run that motivated the issue
— so candidate order `['research','notes']` resolves there forever. It buys nothing in either repo
anyone has looked at. **This declines the letter of issue #9's first direction**, on the evidence
that the direction does not address the failure. Reviving it is ~15 lines if the human wants it.

**A12 — The `git diff` is spelled for machine consumption (pass 1 MINOR 1).** Two ambient-config
dependencies, both reproduced in a scratch repo. Without `-z`, a non-ASCII path comes back C-quoted:

    $ git diff --name-only --diff-filter=A main...HEAD -- docs/
    "docs/superpowers/notes/caf\303\251-se\303\261or.md"

That string becomes the "exactly one survivor", `isSettled` fails on it, and the feature silently
does nothing for any repo whose docs carry an accent — fail-closed but invisible. `-z` alone fixes
it (verified: `-z` emits raw UTF-8 NUL-terminated regardless of `core.quotePath`), so the explicit
`core.quotePath=false` the review suggested is not needed. Rename detection is the second and it
fails **open**: with `diff.renames=false` in a user's gitconfig, a pre-existing doc moved with
`git mv` reappears as `A` and becomes a spurious lone candidate that is a real settled file —

    $ git -c diff.renames=false diff -z --name-only --diff-filter=A main...HEAD -- docs/ | tr '\0' '\n'
    docs/superpowers/notes/café-señor.md
    docs/superpowers/research/moved.md        # ← moved, not added

— so `-c diff.renames=true` is pinned explicitly rather than inherited.

**A13 — The log line is deduplicated per phase entry.** A1 rejects "keep the plugin's path
authoritative and report loudly" partly because reporting needs per-phase-entry dedup state on a 1s
tick (`src/lib/config.ts:23`); an undeduped log line would contradict that and, since
`TASK_STALL_MINUTES` is 45 (`src/lib/config.ts:27`), emit ~2700 identical lines before the first
probe. The dedup is a module-level `Set<string>` in `src/supervisor/tasks.ts` keyed by
`${task_id}:${phase}:${phase_entered_at}`, mirroring how `sendProbes` keys `alreadyProbed`
(`src/supervisor/stall.ts:62-64`). It is process-local and not a `Task` field, so A1's objection —
which is about *persisted* state — does not apply. `src/supervisor/main.ts:160-163` is cited as the
precedent for the log's *shape*, not its cadence; that one is per-delivery.

---

## Testing strategy

TDD, red first, per `prompts/worker-brief.md` §Definition of done.

**T1 (primary, and the answer to MAJOR 1) — a real git worktree, not a temp directory.**
`test/tasks.test.ts:247-252`'s `worktreeWith` is a bare `mkdtempSync` that creates exactly one file;
tests built on it would have gone green through all of BLOCKER 1. The new fixture must `git init` a
repo, commit **≥3** `docs/superpowers/*/*.md` files, `git worktree add` a branch, then write and
commit one extra note at a non-canonical path, and assert adoption. Because the fixture checks out
files with current mtimes, it reproduces BLOCKER 1's precondition and would fail against v1's
design — which is the property that makes it worth writing.

| # | Case | Expected |
|---|---|---|
| T1 | Real worktree, ≥3 pre-existing committed docs, one extra note committed at a non-canonical path | Adopted; phase advances; `artifacts.research` is the real path |
| T2 | Same, but the pre-existing docs are `touch`ed after the worker's commit | Still adopted (proves mtime-independence) |
| T3 | Two non-canonical docs committed on the branch | No adoption; phase stays; **exactly one** log line across several ticks (**A13**) |
| T4 | No commits on the branch | No adoption; phase stays |
| T5 | Only a verdict file under `docs/superpowers/reviews/` added | No adoption (**A6**) |
| T6 | `checkout_path: null` with a valid candidate present | No adoption (**A7**) |
| T7 | `liveIdle: false` with a valid candidate present | No adoption — proves the scan is gated, not merely ineffective |
| T8 | `spec` phase, research note already recorded in `artifacts.research` | Research note not re-adopted; the spec is |
| T9 | Canonical path present and fresh | Adoption never consulted; `artifacts.research` untouched *(regression guard on the happy path)* |
| T10 | Worktree with no `main` ref | No adoption (**A3**) |
| T11 | `spec` re-entered from `spec-review`: canonical spec present but stale, one stray doc committed | **No adoption**; `artifacts.spec` untouched (**A5**, pass 1 MAJOR 1) |
| T12 | A pre-existing doc `git mv`d on the branch, no other new doc | No adoption — rename, not add (**A12**) |
| T13 | Candidate path contains non-ASCII characters | Adopted; the stored path is raw UTF-8, not C-quoted (**A12**) |

**Unchanged and must stay green:** `test/cli-commands.test.ts:159-176`, which asserts the hardcoded
layout. v1 changed that layout; v2 does not touch `src/cli.ts`'s artifact block at all, so the test
needs no edit. If it needs one, something has drifted.

**C2:** extend the existing `cmdBrief` test (`test/cli-commands.test.ts:304-319`) to assert the
brief no longer claims the supervisor stats those paths *and nothing else*.
`test/prompts.test.ts` is not the place — it asserts prompt files exist and are well formed
(`test/prompts.test.ts:16-19`), not what they render to.

**Files this touches outside the declared set (pass 1 MINOR 2).** The plan will edit
`test/tasks.test.ts` and `test/cli-commands.test.ts`. Neither is in `t1.files`, which names source
and one prompt; test files are not listed for either task in this run, so the convention here is
that `--files` declares the implementation surface and its tests follow it. `t2`'s set
(`src/supervisor/stall.ts`, `src/supervisor/main.ts`, `prompts/stall-probe.md`,
`src/lib/status.ts`) has no test file in common with these two, so the overlap gate
(`src/lib/machine.ts:186-187`, `src/lib/phases.ts:105-106`) is not at risk. Named here so the
expectation is explicit rather than assumed.

**Whole-suite gate:** `bun test` (351 pass / 0 fail at `8d32361`) and `bun run typecheck` clean
before the PR.

**Not covered by tests, stated plainly:** that a real worker, given C2's wording, writes to the
given path more often. Unfalsifiable here; C1 is what makes it not matter.

---

## Rejected alternatives

- **`max(phase_entered_at, adopted_at)` as the mtime baseline — the review's own proposed fix for
  BLOCKER 1.** Verified correct for the case it was aimed at (`adopted_at = 1789617141067` sits
  above every worktree file's `1789617140000`), and then **not taken**, because it inherits a hole.
  `hpipe rewind <run> dispatch` sets `adopted_at = null` for every task with a non-null
  `workspace_id` (`src/cli.ts:191-192`) **without clearing `checkout_path` or `workspace_id`**, and
  `applyEvents` re-binds only when `workspace_id === null` (`src/supervisor/tick.ts:37`) — so
  `adopted_at` can never be restored, and the task is left with a live worktree and no adoption
  baseline. `adopted_at ?? 0` then degrades to `phase_entered_at`, which is BLOCKER 1 in full;
  treating null as "no adoption" disables the feature permanently for that task instead. Both
  outcomes are silent. A mechanism with no timestamp has neither failure.
- **mtime newer than `phase_entered_at` (v1's design).** BLOCKER 1.
- **Deriving the artifact directory from the repo (v1's C1, issue direction 1).** **A11**.
- **Deliver the `research` prompt absolutely, like every other phase.** Impossible: at the
  `queued → research` transition `task.pane_id` is null and `addPending` drops a null-pane prompt
  with `dropping prompt for <subject> — no pane` (`src/supervisor/main.ts:160-163`). This is the
  constraint `src/lib/worker-prompt.ts:5-9` already documents.
- **Hold the task in `queued` until the pane and `checkout_path` exist, then transition into
  `research` so the path arrives absolute.** The structurally correct fix; it would delete the
  asymmetry rather than compensate for it. Needs a "brief already handed over" flag to stop the tick
  re-sending the dispatch prompt every second (`src/cli.ts:120-122` documents that hazard), i.e. a
  new field in `src/lib/types.ts`, outside the file set and overlapping the phase machine.
  **Recommended as a follow-up issue.**
- **Reuse `head_sha_at_entry` as the branch-diff base.** It is only stamped for `implement`
  (`src/lib/machine.ts:125`); stamping it per phase means `src/lib/machine.ts`, outside the file set.
- **Scan for the artifact by content** (a header naming the issue). Invents a file-format contract
  this repo does not have; `parseVerdict`'s trailer (`src/lib/predicates.ts:42-43`) is the only
  content contract that exists, and it is for verdicts.
