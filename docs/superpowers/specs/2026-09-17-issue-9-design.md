# Artifact path resolution — design (#9)

**Date:** 2026-09-17
**Issue:** #9 — hardcoded artifact paths make workers write artifacts the supervisor never sees
**Research:** `docs/superpowers/research/2026-09-17-issue-9-research.md` (commit `417684d`)
**Status:** Design v1, pass 0. No prior review.
**Files this task owns** (`t1.files` in the run ledger): `src/cli.ts`, `src/lib/worker-prompt.ts`,
`src/supervisor/tasks.ts`, `src/supervisor/deliver.ts`, `prompts/worker-brief.md`. Everything below
stays inside that set; §Non-goals records what was excluded because it does not.

---

## Problem

The supervisor stats exactly one plugin-chosen path per artifact phase
(`src/supervisor/tasks.ts:202-210`). The worker chooses where it writes. When the two disagree the
task sits in its phase forever: `isFresh` is a `statSync` in a `try` that returns `false` on throw
(`src/lib/predicates.ts:10-20`), so a missing file is indistinguishable from a stale one, and
`gatherSignals` returns `base` unchanged with nothing logged.

The research note established the measured shape of this on the berean-os run of 2026-09-16:

| Delivery form | Artifacts produced | Misfiled |
|---|---|---|
| Absolute path (`spec`, `plan`, all review rows) | 35 | **0** |
| Relative path (`research`) | 6 | **3** |

`research` is the only phase whose path reaches the worker as a bare relative string, once, embedded
in a long brief (`src/lib/worker-prompt.ts:23-25`). Every other phase's path arrives later as an
absolute path via `promptForTaskPhase` (`src/supervisor/tasks.ts:47,92-95`). The asymmetry is
structural: `promptForTaskPhase` is only reached after `advanceTask` changes the phase
(`src/supervisor/tasks.ts:165-167`), the `queued → research` transition takes the other branch and
`continue`s (`src/supervisor/tasks.ts:135-146`), and the `research` row has no `onBlocker`
(`src/lib/phases.ts:92-93`) so no task ever re-enters it.

**Two claims in the issue body do not survive the evidence, and both change the fix:**

1. *"Derive the artifact directory from what the repo actually has"* would have prevented **none** of
   the three failures. All three workers mirrored berean-os's convention in **both** directory and
   filename — `notes/2026-09-16-atomic-store-saves.md`, `notes/bookmark-save-reachability.md`,
   `notes/qr-display-removal.md`. The repo's own naming is `<date>-<slug>.md` (plans, specs) and
   `<slug>.md` (notes); no file in it ever used an `issue-<n>` stem. Resolving only the directory
   would have made the supervisor stat `notes/2026-09-16-issue-27-research.md` and still find
   nothing.

2. *"The directory does not exist"* is not the cause. `docs/superpowers/reviews/` also did not exist
   before that run and is hardcoded the same way (`src/supervisor/deliver.ts:90,93`). 23 review
   files landed in it with zero renames.

So the defect is not the stem. **It is that the plugin's choice of path is only ever *requested* in
prose, never *enforced*, and a worker that declines is met with silence.**

## Goal

A task in `research`, `spec` or `plan` must not stall silently because the worker wrote its artifact
somewhere other than the path the plugin named. The task either advances or its state changes
visibly; it does not sit at a stat that will never succeed.

Secondary: the plugin should stop imposing a directory layout on a repo that already has one
(issue direction 1), which is cheap once the primary goal is met.

## Non-goals

- **Stall probe cadence, backoff, escalation, dead-orchestrator-pane detection, richer liveness.**
  That is issue #15, task `t2`, which owns `src/supervisor/stall.ts`, `src/supervisor/main.ts`,
  `prompts/stall-probe.md` and `src/lib/status.ts`.
- **The task stall probe's missing path.** `src/supervisor/main.ts:262-264` renders the literal
  phrase `whatever clears research for <branch>` into `{{artifact_path}}`, so
  `prompts/stall-probe.md`'s closing line — *"If you finished but wrote the file somewhere else,
  move it to the path above"* — points at a phrase rather than a path, while the run-level probe
  twelve lines earlier does call `absoluteArtifactPath` (`src/supervisor/main.ts:241`). This is a
  real defect and a one-line fix, but `main.ts` is `t2`'s file. **Handed to #15 explicitly.**
- **The `reviews` stem** (`src/supervisor/deliver.ts:90,93`). Equally hardcoded, 23/23 landed
  correctly, delivered absolute. No measured harm; changing it is churn.
- **A per-repo config file.** Nothing in `src/` reads any config from `run.repo_root`; `loadConfig`
  reads `config.env` from `HERDR_PLUGIN_CONFIG_DIR` (`src/lib/config.ts:60`,
  `src/startup.ts:104`), a per-plugin location. The only repo-local file read at all is the agent
  definition (`src/cli.ts:71-74`). A per-repo config is a new mechanism, not an extension of one.
- **Changing the phase machine or the `Task` shape.** `src/lib/phases.ts` and `src/lib/types.ts` are
  outside this task's file set. Every change below uses existing fields.

---

## Architecture

Three changes, in descending order of how much they matter.

### C2 (load-bearing) — adopt the artifact the worker actually wrote

New in `src/supervisor/deliver.ts`, beside the artifact-path resolution it already owns
(`artifactPathFor`, `absoluteArtifactPath`, lines 84-101):

```ts
/**
 * The worker was given one path and wrote another — measured at 3 of 6 research
 * notes on the berean-os run of 2026-09-16, where all three mirrored the repo's
 * own naming instead of the brief's. Rather than stat a path nothing will ever
 * appear at, take the one artifact that did appear, if there is exactly one.
 */
export function adoptableArtifact(
  checkoutRoot: string, phaseEnteredAt: number, claimed: Set<string>,
): string | null
```

It reads `<checkoutRoot>/docs/superpowers/*/` — one level of subdirectory, `.md` files only — keeps
entries whose floored `mtimeMs` is greater than `phaseEnteredAt` (the same comparison and the same
flooring rationale as `isFresh`, `src/lib/predicates.ts:16`), drops any whose repo-relative path is
already in `claimed`, and returns the single survivor's **repo-relative** path or `null`.

Wired into `gatherSignals` (`src/supervisor/tasks.ts:202-210`), which today reads:

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

The `if (!actorIdle) return base` guard stays first and is load-bearing for cost: the scan only ever
runs against an idle worker. When the canonical path is not fresh, the fallback runs; if it yields a
path, that path is written into `task.artifacts[slot]` and the phase advances.

**Adoption is recorded, not just accepted.** Because `task.artifacts[slot]` is mutated and
`advanceTasks`' caller saves the run (`src/supervisor/main.ts:217`), every later prompt that cites
the artifact cites the real file: `prompts/spec.md`'s `{{research_path}}`, the reviewer's brief in
`prompts/spec-review.md`, and `taskArtifactPath` (`src/supervisor/tasks.ts:92-95`). It is also what
makes adoption idempotent and self-deduplicating — the next tick's canonical stat hits the adopted
path directly and the fallback never runs again for that slot. No new `Task` field is needed, which
is what keeps this inside the file set.

### C1 — resolve the artifact directory from the repo (issue direction 1)

In `src/cli.ts`, replacing the hardcoded stems at lines 88-92:

```ts
const ARTIFACT_DIRS = {
  research: ['research', 'notes'],
  spec: ['specs'],
  plan: ['plans'],
} as const
```

For each slot, the first candidate that exists as a directory under
`<run.repo_root>/docs/superpowers/` wins; if none exists, the first candidate is used, which
reproduces today's behaviour exactly. Modelled on `src/cli.ts:71-74`, the only existing place the
pipeline reads the target repo's own layout, and for the same reason: `run.repo_root` is the main
checkout (`src/lib/ledger.ts:29`), it exists at registration time, and the worktree does not —
`checkout_path` is `null` until a herdr hook writes it (`src/cli.ts:87`, `src/supervisor/tick.ts:40`).

Only the **directory** is resolved. The filename stem stays
`<date>-issue-<n>-{research,design,plan}.md` (`src/cli.ts:76-77`), because it carries the issue
number, which is what keeps two tasks in one repo from colliding
(`docs/superpowers/specs/2026-09-15-worker-owned-pipeline-design.md` §Artifacts).

C1 is not the fix. On the berean-os run it would have changed the stat'd path from
`research/…-issue-27-research.md` to `notes/…-issue-27-research.md` and still found nothing. Its
value is that the pipeline stops creating a `research/` directory in a repo that already keeps its
notes elsewhere, and that C2's candidate set is smaller because the canonical and the natural
directory coincide. It is included because the issue asks for it and it is nearly free; see
**A2** for the case against it.

### C3 — stop the brief from making a claim that C2 falsifies

`prompts/worker-brief.md` currently ends its path list with:

> Those paths are relative to this worktree, which is your cwd. Write to them exactly as given: the
> supervisor stats those paths and nothing else, so an artifact written anywhere else is invisible
> and the phase never completes.

After C2, *"stats those paths and nothing else"* is false, and a brief that is wrong about the
mechanism is worse than one that is merely firm. Proposed replacement:

> Those paths are relative to this worktree, which is your cwd — write them exactly as given, stem
> and all. Do not re-derive them from the conventions you see in `docs/`; the stem carries the issue
> number and every later phase cites the path by name. If you write the note elsewhere the
> supervisor will recover it when it can, but recovery is a repair, not a second correct answer.

`src/lib/worker-prompt.ts:23-25` additionally renders the three paths `./`-prefixed, so the brief and
the `research` prompt appended to it (`src/lib/worker-prompt.ts:34-36`) both show a visibly
cwd-anchored path. Only the rendered variable is prefixed; `task.artifacts[slot]` keeps the clean
relative path that everything stats. `prompts/research.md` needs no edit — it reads the same
`{{research_path}}` variable and is outside this task's file set.

---

## Data and control flow

**Registration** — unchanged except where marked.

1. `cmdTask` validates the agent definition against `run.repo_root` (`src/cli.ts:71-74`).
2. **[C1]** `resolveArtifactDirs(run.repo_root)` reads `docs/superpowers/` and picks one directory
   per slot.
3. `task.artifacts` is built from those directories plus the unchanged stem (`src/cli.ts:76-77`),
   with `checkout_path: null` (`src/cli.ts:87`).
4. The task moves `queued → research` and the brief is rendered and returned
   (`src/cli.ts:122-126`), **[C3]** with `./`-prefixed paths.

**Execution** — per tick, per task, in `gatherSignals`.

5. Row is `research`/`spec`/`plan`. If the actor is not idle → `base`, unchanged. *(No scan.)*
6. Canonical absolute path is fresh and settled → `artifactFresh: true`, unchanged.
7. **[C2]** Canonical path not fresh → `adoptableArtifact(checkoutRoot, task.phase_entered_at, claimed)`
   where `claimed` is every non-null path in `task.artifacts` (the other two slots and every recorded
   verdict), so the research note cannot be re-adopted as the spec.
8. Exactly one fresh candidate, and it passes `isSettled` → `task.artifacts[slot] = candidate`,
   return `artifactFresh: true`.
9. Zero or two-or-more candidates → `base`, unchanged. Identical to today's behaviour.
10. `advanceTask` advances the row; `promptForTaskPhase` renders the next phase's prompt with
    absolute paths built from the **adopted** value (`src/supervisor/tasks.ts:92-95`);
    `src/supervisor/main.ts:217` saves the run.

The worked case, issue 38 on the berean-os run: worker writes
`docs/superpowers/notes/qr-display-removal.md`, commits, pushes, goes idle. Canonical
`docs/superpowers/research/2026-09-16-issue-38-research.md` does not exist. The scan finds exactly
one fresh `.md` under `docs/superpowers/*/`. It is adopted, `task.artifacts.research` becomes
`docs/superpowers/notes/qr-display-removal.md`, the task advances to `spec`, and `prompts/spec.md`
tells the worker to build on that file by its real name. The hand-run `ls` and the three
`docs: move … to the path the supervisor stats` commits do not happen.

---

## Error handling

| Condition | Behaviour | Precedent |
|---|---|---|
| `docs/superpowers/` absent, unreadable, or `readdirSync` throws | catch → `null` → today's behaviour | `isFresh` swallows its `statSync` throw (`src/lib/predicates.ts:17-18`) |
| Zero fresh candidates | no adoption, keep waiting | today's behaviour |
| Two or more fresh candidates | **no adoption**, keep waiting | fail closed; advancing on the wrong file is worse than waiting |
| Candidate is a directory or not `.md` | skipped | — |
| Candidate resolves outside the checkout root (symlink) | skipped | `resolve()` and prefix-check before accepting |
| `task.checkout_path` is null | scan base is `run.repo_root`, matching `absoluteArtifactPath` (`src/supervisor/deliver.ts:100`) | — |
| Adopted file later deleted | next tick's canonical stat fails and the fallback re-runs | adoption is a value, not a latch |

`isSettled` sleeps `FILE_SETTLE_MS` (default 750ms, `src/lib/config.ts:28`) on every call
(`src/lib/predicates.ts:27-35`). It is therefore called on **one** candidate, after the single
survivor is chosen — never per candidate.

---

## Assumptions

Each is a behavioural choice, stated so the review can attack it rather than having to find it.

**A1 — Adopting the worker's path is better than refusing it.** The alternative is to keep the
plugin's path authoritative and report the mismatch loudly. Refused because reporting needs
per-phase-entry dedup state to avoid re-prompting on a 1s tick (`src/lib/config.ts:23`), that state
is a new `Task` field, and `src/lib/types.ts` is outside this task's file set. Adoption is
self-deduplicating because it makes the canonical path correct. *This reverses the stated design
principle in `docs/superpowers/specs/2026-09-15-worker-owned-pipeline-design.md` §Artifacts —
"paths rendered by the plugin and never chosen by the worker" — and that is the single most
attackable decision in this document.* The counter-argument the review should weigh: the principle
exists so the freshness predicate knows where to look, and C2 preserves exactly that by writing the
discovered path back into the ledger before anything else reads it.

**A2 — C1 earns its place despite preventing zero measured failures.** It is ~15 lines, it satisfies
the issue's first direction, and it stops the plugin writing a `research/` directory into repos that
keep notes elsewhere. The case against: it is unfalsifiable by the run that motivated the issue, and
a reviewer could reasonably call it scope. Dropping C1 does not weaken C2.

**A3 — `notes` is an acceptable directory for a research artifact.** It is what berean-os used for
exactly this kind of note before the run (`notes/host-shim-feasibility.md`,
`notes/phase-0-baseline.md`). Where both `research/` and `notes/` exist — as in berean-os today —
`research/` wins by candidate order, so resolution is stable once a repo has been through one run.
Note that C1 is a **no-op in this repo**: `docs/superpowers/` here held `plans`, `reviews` and
`specs` before this task, with no `notes/`, so `research` falls through to the canonical name. The
`research/` directory here exists only because the research phase of this task created it.

**A4 — `docs/superpowers/*/` is the right scan scope.** All three measured misfilings landed there.
Scanning all of `docs/` would match a worker who also touched unrelated documentation; scanning only
the canonical directory would have caught none of the three.

**A5 — "exactly one" is the right threshold.** Two fresh notes means the supervisor cannot tell
which is the artifact, and guessing advances the phase on the wrong file, which then propagates into
the spec, both reviews and the PR. Waiting is recoverable; a wrong adoption is not.

**A6 — Gating the scan on `actorIdle` is sufficient cost control.** The guard already exists
(`src/supervisor/tasks.ts:205`). A `readdirSync` over a handful of directories once per second per
*idle* task is not worth caching. If the review disagrees, the cheap mitigation is to scan only when
the phase has been open longer than `FILE_SETTLE_MS`.

**A7 — The `./` prefix in the brief is cosmetic and low-confidence.** It costs one line in
`src/lib/worker-prompt.ts` and is included because the failing population was exactly the
relative-path one. There is no evidence it would have changed any of the three outcomes. It is the
first thing to cut.

**A8 — The stem stays `<date>-issue-<n>-*`.** Matching the repo's descriptive-slug naming as well as
its directory would remove the issue number, which is what guarantees uniqueness across tasks in one
repo. C2 makes the stem mismatch survivable, so there is no reason to trade the guarantee away.

---

## Testing strategy

TDD, red first, per `prompts/worker-brief.md` §Definition of done. Modelled on
`test/tasks.test.ts:240-274`, which already builds a real worktree in a temp directory
(`worktreeWith`, `test/tasks.test.ts:247-252`) and drives `advanceTasks` against it — real
filesystem, no injected fs fake. C2's whole subject is what is on disk, so faking the filesystem
would test the fake.

**`test/tasks.test.ts` — C2**

1. Worker wrote `docs/superpowers/notes/whatever.md` and the canonical path is absent → phase
   advances to `spec` **and** `task.artifacts.research` equals the adopted relative path.
2. Two fresh `.md` files under `docs/superpowers/*/` → phase stays `research`, `artifacts.research`
   unchanged.
3. Zero candidates → phase stays `research`. *(Regression guard on today's behaviour.)*
4. One candidate whose mtime predates `phase_entered_at` → phase stays `research`. Mirrors the
   existing stale-artifact test at `test/tasks.test.ts:265-274`.
5. Actor not idle (`liveIdle: async () => false`) with a valid candidate present → phase stays
   `research`, proving the scan is gated and not merely ineffective.
6. In `spec` phase with the research note already recorded in `artifacts.research` and freshly
   touched → not re-adopted as the spec.
7. Canonical path present and fresh → adopted path is not consulted; `artifacts.research` is
   untouched. *(Regression guard: the happy path must not change.)*

**`test/cli-commands.test.ts` — C1**

8. Fixture repo with `docs/superpowers/notes/` and no `research/` → `task.artifacts.research` is
   under `docs/superpowers/notes/`; `spec` and `plan` unchanged.
9. Fixture repo with both `research/` and `notes/` → `research/` wins.
10. The existing test at `test/cli-commands.test.ts:159-176` **stays green unmodified**: its
    fixture repo (`test/cli-commands.test.ts:20-23`) contains only `.claude/agents/`, so no
    candidate directory exists and C1 falls back to the canonical names it already asserts. If that
    test needs editing, C1's fallback is wrong.

**`test/cli-commands.test.ts` — C3**

11. Extending the existing `cmdBrief` test (`test/cli-commands.test.ts:304-319`): the rendered brief
    contains the `./`-prefixed path, and the stored `task.artifacts.research` is still unprefixed.
    Guards the one way C3 could break C2. `test/prompts.test.ts` is not the place — it asserts that
    prompt files exist and are well formed (`test/prompts.test.ts:16-19`), not what they render to.

**Whole-suite gate:** `bun test` (351 pass / 0 fail at `417684d`) and `bun run typecheck` both clean
before the PR.

**Not covered by tests, stated plainly:** that a real worker, given the C3 wording, writes to the
given path more often. That is unfalsifiable here; C2 is what makes it not matter.

---

## Rejected alternatives

- **Deliver the `research` prompt absolutely, like every other phase.** Impossible within this
  design. At the `queued → research` transition `task.pane_id` is null, and `addPending` drops a
  prompt with a null pane with `dropping prompt for <subject> — no pane`
  (`src/supervisor/main.ts:160-163`). This is the constraint `src/lib/worker-prompt.ts:5-9` already
  documents.
- **Hold the task in `queued` until the pane and `checkout_path` exist, then transition into
  `research` so `promptForTaskPhase` renders it absolute.** This is the structurally correct fix and
  would delete the asymmetry entirely. It needs a "brief already handed over" flag to stop the tick
  re-sending the dispatch prompt every second (`src/cli.ts:120-122` documents exactly this hazard),
  which means a new `Task` field in `src/lib/types.ts`, outside this task's file set and overlapping
  the phase machine. **Recommended as a follow-up issue**, not smuggled in here.
- **A new intermediate phase row.** Same objection: `src/lib/phases.ts` is outside the file set.
- **Scan for the artifact by content** (e.g. a header naming the issue). Invents a file-format
  contract this repo does not have; `parseVerdict`'s trailer contract
  (`src/lib/predicates.ts:42-43`) is the only content contract that exists and it is for verdicts.
- **Make the reviews stem repo-derived too.** Verdict paths are computed at delivery time from a
  fallback inside `artifactPathFor` (`src/supervisor/deliver.ts:90,93`) rather than stored at
  registration; resolving them per repo needs a stored base on `Run`, which is `src/lib/types.ts`.
  23/23 correct means there is nothing to buy.
