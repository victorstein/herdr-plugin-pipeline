# Research — issue #26: a rewind makes the next review overwrite an earlier review's verdict file

Established against this worktree at `be18175` (branch `fix/26-verdict-overwrite`), against the four
branches that still carry the damage, and against the live ledger at
`~/.local/state/herdr/plugins/stein.pipeline/runs/`. Every claim below is a `file:line` citation or a
command whose output is quoted. Modelled on `docs/superpowers/research/2026-09-18-issue-21-research.md`.

Issue #26 cites `src/supervisor/deliver.ts:88-90` and `src/cli.ts:177`/`:183`. Both line spans have
moved since the issue was filed — #21's resolver (`2016ee0`, `fix: resolve every hpipe command
against the caller's repo and a live run (#44)`) rewrote `src/cli.ts`. The behaviour is unchanged;
the current addresses are given below and are what the spec must cite.

## Installed versions

    $ bun --version      → 1.3.14
    $ node --version     → v24.16.0
    $ herdr --version    → herdr 0.9.0
    $ bunx tsc --version → Version 5.9.3
    $ cat version.txt    → 1.2.10

Dependencies are dev-only (`package.json:10-13`): `@types/bun@latest`, `typescript@^5.6.0`. No runtime
dependency, no build step.

Baseline, green before any change:

    $ bun test          → 503 pass, 0 fail, 1265 expect() calls, 34 files, 10.97s
    $ bun run typecheck → tsc --noEmit, no output, exit 0

### The running supervisor is byte-identical to what is measured here

    $ herdr plugin list
    - stein.pipeline (Pipeline) enabled [github:victorstein/herdr-plugin-pipeline@be181757beca96069b7f209163fb7538c0e6382f]

    $ git rev-parse HEAD
    be181757beca96069b7f209163fb7538c0e6382f

The installed plugin is pinned to this branch's base commit, so every reading below describes the CLI
and supervisor actually driving this run. Nothing written in this worktree changes them.

## Which files own the behaviour

Four addresses, in three files. There are no others.

| Site | What it does |
|---|---|
| `src/supervisor/deliver.ts:97-107` | `artifactPathFor` — derives the verdict path from `phase` + `counterFor(record, phase)` |
| `src/lib/machine.ts:7-9`, `:17-21` | `counterFor` / `bumpCounter` — the counter the path is keyed on |
| `src/cli.ts:353` | `cmdRewind`, task branch — `task.passes = {}` |
| `src/cli.ts:360` | `cmdRewind`, run branch — `run.passes = {}` |

The path reaches an agent through exactly two renders, both of which pass it as `{{verdict_path}}`:

- `src/supervisor/tasks.ts:55` — `verdict_path: absoluteArtifactPath(run, task) ?? ''`
- `src/supervisor/deliver.ts:253` — `verdict_path: verdictPath` (run-level `branch-review`)

and five prompts instruct the reviewer to write to it verbatim: `prompts/spec-review.md:7-9`,
`prompts/plan-review.md:9`, `prompts/pr-review-intent.md:11`, `prompts/pr-review-quality.md:11`,
`prompts/branch-review.md:23`. `prompts/spec-review.md:16-17` additionally requires the reviewer to
**commit and push** the file, which is why the loss lands on the branch rather than staying local.

## The current control flow

1. A review row (`spec-review`, `plan-review`, `pr-review-intent`, `pr-review-quality`,
   `branch-review`) is entered. Each carries `counter: <its own phase>` in the phase table
   (`src/lib/phases.ts:96-98`, `:101-103`, `:111-113`, `:114-116`, `:64-66`).
2. `promptForTaskPhase` renders `verdict_path` from `artifactPathFor`
   (`src/supervisor/deliver.ts:101-103`):

       const key = `${task.phase}-${counterFor(task, task.phase)}`
       return task.artifacts.verdicts[key]
         ?? join(REVIEWS_DIR, `issue-${task.issue}-${key}.md`)

3. The reviewer writes and commits that file.
4. On `BLOCKER`, `advanceLoopingRow` (`src/lib/machine.ts:113-127`) calls `bumpCounter`, so the next
   pass renders `…-1.md`, then `…-2.md`. This is correct and is pinned by
   `test/deliver.test.ts:148-154` and `test/machine-task.test.ts:143-147`.
5. `hpipe rewind` sets `passes = {}` (`src/cli.ts:353`, `:360`). The next entry into that review row
   renders `…-0.md` again — the name an earlier review already holds.

`src/lib/machine.ts:11-16` states the invariant the fix breaks today: *"Monotone by construction.
Nothing in this module decrements or deletes a counter — only `hpipe rewind` clears the map."*
`src/lib/phases.ts:21-26` repeats it on `PhaseRow.counter`. The counter is monotone; the *path* is
not, because rewind is the one exception and the path rides on the counter.

## The clobber is not merely permitted — it is required for the phase to advance

This is the finding that constrains the fix, and it is not in the issue.

`verdictFor` (`src/supervisor/main.ts:193-199`) gates on `isFresh(absolute, t.phase_entered_at)`, and
`isFresh` is `Math.floor(statSync(path).mtimeMs) > phaseEnteredAt` (`src/lib/predicates.ts:10-20`).
`cmdRewind` re-stamps `task.phase_entered_at = Date.now()` (`src/cli.ts:355`, run: `:361`). So after a
rewind the pre-existing file at the collision path reads **stale**, and the supervisor simply waits.

The only event that satisfies the row is the reviewer writing over that file. A fix shaped as
"refuse to write a path that already exists" therefore does not stop at refusing: unless it also
hands the reviewer a different path, it parks the row until a human intervenes — converting silent
data loss into a silent deadlock. Any refusal has to be paired with a new path.

## Verified on the branches: three manual repairs, one real loss

`fix/15-stall-escalation` (still present locally; not on `origin`):

    $ git log --oneline --follow fix/15-stall-escalation -- docs/superpowers/reviews/issue-15-spec-review-0.md
    71a7db3 docs: adversarial review of the Ruling 2 spec — CLEAR
    ddd5086 docs: clear the verdict-path collision ahead of the next review (#26)
    f672bfe docs: adversarial review of the narrowed issue #15 spec — BLOCKER
    a4f04ca docs: adversarial spec review for issue #15, pass 0 — BLOCKER

    $ git log --oneline --diff-filter=M fix/15-stall-escalation -- docs/superpowers/reviews/issue-15-spec-review-0.md
    f672bfe docs: adversarial review of the narrowed issue #15 spec — BLOCKER

    $ git show --stat --oneline f672bfe
     docs/superpowers/reviews/issue-15-spec-review-0.md | 662 ++++++++++-----------
     1 file changed, 314 insertions(+), 348 deletions(-)

`f672bfe` (2026-09-16) is the real loss: a whole-file replacement, not an edit. The pass-0 review it
replaced survives only in git history.

The three manual repairs, all dated 2026-09-17, all of the form *`git mv` the occupant aside and
commit first*:

    432f4d7  docs: preserve the #13 pass-0 spec review before the counter reset
    944210d  docs: preserve the pass-1 review before its path is reused (#26)
    ddd5086  docs: clear the verdict-path collision ahead of the next review (#26)

    $ git show --stat --oneline ddd5086
     ...-15-spec-review-0.md => issue-15-spec-review-narrowed-r1-preserved.md} | 0
     ...-15-spec-review-1.md => issue-15-spec-review-narrowed-r2-preserved.md} | 0
     2 files changed, 0 insertions(+), 0 deletions(-)

Their output is still in the tree — `git ls-files 'docs/superpowers/reviews/*preserved*'` returns
four files. `fix/13-digest-content` shows the repair working (`432f4d7` preserves, then `bf89f11`
writes the new pass-0); `fix/15-stall-escalation` shows it being forgotten once.

## How often this is reached: 13 rewinds in 3 days

Counted over the nine run ledgers on disk, by `history` entries with `why === 'manual rewind'`:

| Run | Rewind targets |
|---|---|
| `herdr-plugin-pipeline-20260917-bug-fixing-and-enhancements-qc13` | run:execute, t2:spec ×2, t1:done, t2:done, t1:blocked-on-decision, t1:done, t2:blocked-on-decision, t2:done |
| `herdr-plugin-pipeline-20260918-fix-run-resolution-and-the-last-mile-v0qh` | run:execute, t2:implement |
| `herdr-plugin-pipeline-20260917-validate-the-silent-gates-rjms` | t2:spec |
| `berean-os-20260917-working-on-open-issues-xilp` | t4:spec-review |

Two details the issue does not carry:

- **`passes` is cleared wholesale, not for the phase rewound to.** `task.passes = {}`
  (`src/cli.ts:353`) drops `ci`, `pr-review-intent`, `pr-review-quality` and `spec-review` together.
  So `t2:implement` on the v0qh run reset the two PR-review counters, and a collision surfaces later
  at a filename unrelated to the rewind target. `prompts/escalate.md:17` tells the orchestrator the
  command "resets the pass count for that phase" — singular, and wrong.
- **Rewinding directly onto a review row is a used path** (`t4:spec-review`), so the collision can be
  the very next prompt, with no producer phase in between.

## `task.artifacts.verdicts` is a read with no writer

`src/supervisor/deliver.ts:91-94` says so in a comment, and it is true:

    $ grep -rn "verdicts" src/
    src/cli.ts:229:      verdicts: {},              # constructor
    src/lib/ledger.ts:35:    artifacts: { verdicts: {} },   # constructor
    src/lib/types.ts:83, :100                          # the type
    src/supervisor/deliver.ts:92, :102, :106           # the comment and the two reads

Confirmed against every run on disk — all nine have `run.artifacts.verdicts === {}` and every task's
`artifacts.verdicts === {}`. Only tests seed it (`test/deliver.test.ts:159`, `:240`).

Consequence for the fix: the override slot exists, is typed, is already persisted by `saveRun`, and
is already honoured ahead of the derived default at `deliver.ts:102` and `:106` — with
`test/deliver.test.ts:156-161` pinning that precedence. Recording a resolved path there is the
pattern this repo already uses for artifacts: `src/supervisor/tasks.ts:264-267` writes an adopted
path back onto `task.artifacts[slot]` precisely so later prompts cite it and the resolution is
idempotent. That is the nearest existing example of this kind of change.

## Constraints the fix has to survive

- **`schema_version` is a hard gate, not a warning.** `isCurrentSchemaRun` is
  `run.schema_version === 2` (`src/supervisor/main.ts:32-34`), and `src/lib/status.ts:112-117`,
  `:143-146` branch on it; `test/tick.test.ts:148-152` pins "a run without schema_version 2 is never
  advanced". Bumping it strands the four live runs above rather than migrating them. Any new
  persisted field must be optional and must read correctly as absent on a v2 run already on disk.
- **`adoptableArtifacts` filters by the reviews prefix**, not by a claimed set
  (`src/supervisor/deliver.ts:180`, tested at `test/deliver.test.ts:287-295`), *because* nothing
  populates `verdicts`. Starting to populate it does not invalidate that filter, but the comment at
  `:91-94` becomes false and has to be corrected with the change.
- **`README.md` is a sibling's file this batch** (#16 holds `prompts/dispatch.md`, `src/hooks/`,
  `README.md`, `src/lib/config.ts`, `test/config.test.ts`). `README.md:100` documents exactly what
  `hpipe rewind` clears, and `README.md:116` describes the reviews directory. If the fix changes
  observable rewind behaviour, that line goes stale and I cannot edit it — it has to be coordinated,
  not silently left wrong.
- **`prompts/escalate.md` and `prompts/stall-escalate.md` are mine** and both print the `rewind`
  command (`escalate.md:15-17`, `stall-escalate.md:14`); `escalate.md:17`'s description of what it
  resets is already inaccurate.
- **Three tests pin today's behaviour** and will have to move with the change:
  `test/deliver.test.ts:148-154` (path keyed by the counter), `test/cli.test.ts:117-129` and
  `test/cli-commands.test.ts:228-239` (rewind clears the whole counter map). `cmdRewind` also already
  returns `"…; counters cleared"` (`src/cli.ts:373`), which is user-visible text.
- **CI is a PR-title lint only** (`.github/workflows/pr-title-lint.yml`). `bun test` and
  `bun run typecheck` are run by hand and reported in the PR body.

## Carried into the spec

1. The defect is one line of derivation (`deliver.ts:101`) meeting one line of reset (`cli.ts:353`),
   with `cli.ts:360` as the run-level twin. Both must be covered; the issue's title only implies the
   task one.
2. "Refuse to overwrite" cannot stand alone — see *the clobber is required for the phase to advance*.
   A monotone name, or a recorded path, has to come with it.
3. `artifacts.verdicts` is the existing, already-honoured, already-persisted override slot, and
   `tasks.ts:264-267` is the in-repo precedent for writing a resolved artifact path back onto the
   record. A fix that keys the path off something monotone and records it there invents no new
   pattern.
4. No `schema_version` bump. Whatever is added must be optional and absent-safe.
