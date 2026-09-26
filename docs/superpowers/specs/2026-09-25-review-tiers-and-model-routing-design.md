# Review tiers and model routing — design

Pass 2. Written against `main` at `338e09a`. Pass 1 was reviewed adversarially in
`docs/superpowers/reviews/2026-09-25-review-tiers-design-adversarial-1.md` (BLOCKER, 1/5/9); every
finding is resolved below, and the table at the end maps each to where it landed.

Two changes, specified together because both are per-phase properties of the task table and both
land in the same rendered prompts:

1. **Review tiers.** Each task carries a tier — `light`, `standard` or `heavy` — that decides which
   review phases it runs. Today every task runs all four review stages.
2. **Model routing.** Judgment stays on Opus; the code-writing in `implement` moves to a Sonnet
   subagent. Today nothing pins a model: workers start with
   `herdr agent start … --kind claude -- --dangerously-skip-permissions` (`src/lib/unstarted.ts:92`,
   `prompts/dispatch.md:11`) and every phase and reviewer inherits the user's default.

**On-disk format change.** A ledger holding a task in the new `pr-review` phase makes `taskRow` throw
under any build before this one. So a rollback to an earlier tag cannot read such a ledger, and after
an upgrade **the supervisor must be restarted**: a supervisor still running old code alongside a new
CLI would route a light task through `pr-review-intent` while the CLI printed it a light brief. The
release notes and README say so.

## Evidence

Every verdict file that reached `main` in `herdr-plugin-pipeline` and `berean-os` (20 tasks, 5 runs),
tallied on 2026-09-25 by the trailer's `VERDICT:` line:

| Stage | Tasks with ≥1 BLOCKER |
|---|---|
| `spec-review` | 10 / 20 |
| `plan-review` | 4 / 20 |
| `pr-review-intent` | 0 / 18 |
| `pr-review-quality` | 0 / 18 |
| `branch-review` | 0 / 5 runs |

`plan-review` blockers did not follow `spec-review` blockers (issues 30 and 31 cleared spec first
time, then blocked on plan), so "skip plan review after a clean spec review" is not a safe rule. The
PR stages never gated but did surface MAJORs fixed inline under a `CLEAR` (e.g.
`issue-26-pr-review-quality-0.md`); they act as a polish pass, and two of them over one diff is the
clearest redundancy. Caveats: small sample; only merged work survives, so escalated-and-abandoned
tasks may be missing; no cost data per stage.

## Decisions

| Question | Decision |
|---|---|
| Who sets the tier | The orchestrator at intake (`hpipe task --tier`); a `pipeline:tier-*` issue label overrides it |
| Can it change mid-run | Raise from anywhere; lowering is refused from pipeline-owned panes |
| Default | `standard` for new registrations; `heavy` (today's behaviour) for tasks in ledgers written before this change |
| What each tier runs | table below |
| `branch-review` | skipped when at most one task merged |
| Models | orchestrator, worker session, every reviewer: Opus. The `implement` subagent: Sonnet |
| How `implement` gets Sonnet | the Opus worker dispatches the coding to a subagent with `model: sonnet`; the pane's model is never switched |
| Where model choices live | code constants in `src/lib/models.ts`, not `config.env` |
| Worker pane model | inherited from the user's default, not pinned with `--model` |

| Tier | `spec-review` | `plan-review` | PR review |
|---|---|---|---|
| `light` | ✓ | – | combined `pr-review` |
| `standard` | ✓ | ✓ | combined `pr-review` |
| `heavy` | ✓ | ✓ | `pr-review-intent` then `pr-review-quality` (today's pipeline) |

Rejected:

- **Switching the pane with `/model`.** It drops the prompt cache and is a keystroke into a pane with
  no reliable confirmation — the class of delivery bug several live runs already hit.
- **Model names in `config.env`.** Only the supervisor loads config; the CLI's `Ctx` carries none
  (`src/cli.ts:33`) and already ignores `GH_BIN` (`src/cli.ts:218-219`). The CLI renders most
  model-bearing text (`hpipe task`'s dispatch block, `hpipe rewind`'s prompt at `src/cli.ts:630`,
  `hpipe brief`), so a config key would be honoured on one dispatch path and not the other. Nobody
  asked for the models to be configurable; constants avoid the split entirely. Aliases (`opus`,
  `sonnet`) follow each family's newest model, so a release needs no change.
- **Pinning the worker pane with `--model opus`.** The user's default today is a `[1m]` Opus
  variant; the bare alias may select the standard-context one, and a worker runs research through
  PR in one pane. Leaving the flag off keeps today's start line unchanged and keeps the worker on the
  user's Opus default. README and the skill state the requirement: run Claude with Opus as the
  default model.

## 1. Data model and routing

### Task record (`src/lib/types.ts`, `Task`)

    tier?: Tier                      // 'light' | 'standard' | 'heavy'
    tier_history?: TierChange[]

    interface TierChange {
      at: number
      from: Tier | null              // null on the registration entry
      to: Tier
      source: 'label' | 'flag' | 'default' | 'hpipe-tier'
      pane: string | null            // caller's HERDR_PANE_ID, null when unset
      why: string                    // registration entries: the printed `tier:` reason
    }

Both fields optional so ledgers written before this change still parse. One reader, `tierOf(task)`,
returns `task.tier ?? 'heavy'`: an in-flight run keeps today's behaviour across an upgrade, and
nothing is written back until the task's tier changes.

Tier changes are recorded in `tier_history` **only**, not in `run.history`. `enteredByRewind`
(`src/lib/unstarted.ts:74-77`) reads the task's last `run.history` entry to tell a rewound task from
one that was never dispatched; a tier entry landing after a rewind would hide the rewind and delay the
unstarted-worker probe.

### Phase table (`src/lib/phases.ts`)

- `TaskPhase` gains `'pr-review'`.
- A new row between `implement` and `pr-review-intent`:

      { phase: 'pr-review', actor: 'worker', signal: 'verdict',
        onClear: 'pr-review-intent', onBlocker: 'implement', counter: 'pr-review',
        prompt: 'pr-review', stallable: true, holdsFiles: true, tiers: ['light', 'standard'] }

- `implement.onClear` becomes `'pr-review'`.
- `PhaseRow` gains `tiers?: readonly Tier[]` (absent = every tier).
- `tiers`: `plan-review` → `['standard', 'heavy']`; `pr-review-intent`, `pr-review-quality` →
  `['heavy']`. Every other row has none.

### Models (`src/lib/models.ts`, new)

    export const IMPLEMENT_MODEL = 'sonnet'
    export const REVIEW_MODEL = 'opus'

Pure constants, importable from `src/lib/` by both the CLI and the supervisor.

### Routing

One resolver, pure, in `src/lib/phases.ts`:

    export function nextPhase(tier: Tier, from: PhaseRow<TaskPhase>): TaskPhase

Starting at `from.onClear`, it follows `onClear` while the landed-on row's `tiers` excludes `tier`,
and returns the first row the tier includes. It throws if the walk runs off the table (a table bug,
caught by §5's invariant test). `onBlocker` targets (`spec`, `plan`, `implement`) are never tiered,
so blocker routing is unchanged.

Every forward read of a task row's `onClear` past `research` goes through it:

- `advanceLoopingRow` on clear (`src/lib/machine.ts:167-168`) and the `research`/`spec`/`plan` case
  (`:184-187`);
- the `implement` case, which hard-codes `'pr-review-intent'` today (`src/lib/machine.ts:194`);
- `workerStillNeeded`'s reachability walk (`src/supervisor/tick.ts:149`);
- the worker brief's phase loop (§3).

The `queued → research` reads (`src/cli.ts:353,510,623,714`, `src/lib/unstarted.ts:52,149,192`,
`src/lib/worker-prompt.ts:34`, `src/supervisor/tasks.ts:207`, `src/lib/machine.ts:98`) stay on raw
`onClear`: `research` is untiered.

A tier change needs no special case: the next forward step reads the current tier.

### Every site that must learn `pr-review`

The typechecker does **not** catch these — phase records are `Partial<>` and every phase switch has a
`default` — so each is listed, and §5's table-driven test is the backstop:

| Site | Change |
|---|---|
| `advanceTask` review case list, `src/lib/machine.ts:197-200` | add `case 'pr-review':` — without it the task never leaves `pr-review` |
| `renderTaskPhasePrompt` switch, `src/supervisor/tasks.ts:120-130` | add `case 'pr-review'` rendering `pr-review` |
| the second phase switch, `src/supervisor/tasks.ts:365-367` | add `case 'pr-review':` alongside the other review rows |
| `test/prompts.test.ts:9-16` `REVIEW_PROMPTS` / `ALL` | add `pr-review` |
| `test/table.test.ts:57` `WORKER_REVIEW_PROMPTS` | add `pr-review` |

`PHASES_BEFORE_A_PR` (`src/cli.ts:204-206`) is unchanged — `pr-review` follows a PR.

### Rewind

`hpipe rewind` onto a row the task's tier excludes is allowed — a human is being explicit — and prints
`warning: <phase> is not in tier <tier>; the task will leave it by the <tier> route`. Forward travel
from there follows the tier.

## 2. Setting and changing the tier

### At registration

`hpipe task … [--tier light|standard|heavy]`.

- Registration reads the issue's labels with one `gh issue view <n> --json labels`, through an
  injected `readLabels` dependency (for tests, like `fileIssue`) and memoised on the
  `RegistrationAttempt` the way `fileIssueOnce` is (`src/cli.ts:393-395`), so a stale-save retry of
  `registerTask` (`src/cli.ts:402`) does not call `gh` again. For `--title`/`--body-file` the freshly
  filed issue has no labels and the read is skipped.
- Exactly one `pipeline:tier-<name>` label wins over `--tier`. Two or more tier labels: registration
  exits non-zero naming them, nothing is recorded.
- An unknown `--tier` value or unknown label suffix (`pipeline:tier-huge`): exit non-zero.
- `gh` failure: fall back to `--tier` (else `standard`) and continue.
- `hpipe task` prints one line, always, after `task_id:`:

      tier: light (label pipeline:tier-light; --tier said standard)
      tier: standard (--tier)
      tier: standard (default)
      tier: heavy (--tier; labels unreadable: <reason>)

  The parenthetical is the registration entry's `why`.
- Labels are read at registration only. The supervisor does not poll them; `hpipe tier` is the
  human's mid-run override.

### Mid-run

`hpipe tier --task <id> <tier> --why "<reason>"`, a new subcommand wrapped in `retryingOnStale` like
the others.

- `--why` is required.
- **Raise**: allowed from any pane.
- **Lower**: refused when `HERDR_PANE_ID` equals `run.orchestrator_pane`, or any task's `pane_id` /
  `last_pane_id` in that run, with: `lowering a tier needs a human; run this from your own pane`.
  This is a guard against an agent talking a task down, not authentication. **Known gap:** an agent
  whose pane was moved (`pane.moved` rewrites `pane_id` without setting `last_pane_id`,
  `src/supervisor/tick.ts:351-360`) or whose orchestrator pane was rebound
  (`src/supervisor/orchestrator.ts:57,99`) still carries its old id and passes the guard. Accepted:
  the prompts forbid lowering, and the change is recorded with its pane in `tier_history`.
- Same tier: no-op, exit 0, nothing recorded.
- Terminal task (`done`, `failed`, `orphaned`, `blocked-on-failure`): refused.

**The phase the task is in always completes.** A tier change never interrupts it; only the next
forward step changes. A heavy task lowered to light in `pr-review-intent` finishes that review, then
skips `pr-review-quality` to `ci`. A light task raised to heavy in `pr-review` finishes it, then runs
`pr-review-intent` and `pr-review-quality`. A raise after a skipped `plan-review` does not go back to
it; `hpipe rewind` does. A decision returns to `decision_from` as today; the step after reads the new
tier.

### Who is told to raise

- `prompts/research.md`: if research shows the task is bigger than its tier — another surface, a
  contract, a migration — run `{{hpipe}} tier --task {{task_id}} <higher> --why …` before writing the
  spec.
- `prompts/decision.md`: the same hint to the orchestrator; a decision is often where scope grows.
- The worker brief and the orchestrator prompts say never to lower a tier.

### Intake guidance (`prompts/intake.md`, step 4)

- **light** — one surface, a handful of files, and the issue already pins down the exact change: no
  API, contract or schema decision left open.
- **heavy** — changes a contract another surface consumes, migrates data, touches security or auth,
  concurrency, or state-machine code; or the orchestrator is not sure.
- **standard** — everything else.
- When unsure, pick the higher tier: under-review is the costly mistake.

### Visibility

- `hpipe status` task line (`src/lib/status.ts:421-431`) gains the tier as the bit after the phase
  bracket: `  t2 <branch> #<n> [implement 5m] light idle …`. `describeWake`, `parkedFooter` and
  `catchUpDigest` (`src/supervisor/tick.ts:60,88,103`) are unchanged.
- `hpipe show --task` (`formatTaskDetail`, `src/lib/status.ts:455-478`) gains, after `phase:`:

      tier:       light
      tier log:   <time> — → standard (default) · <time> standard → heavy (hpipe-tier, pane p_3): <why>
      visited:    research → spec → spec-review → plan → implement → pr-review → ci

  `visited` is the task's phases in order, read from `run.history` entries with its `task_id`. This
  is the view §5's smoke run reads.

## 3. Prompts

### Rendering plan

`render()` substitutes tokens and has no conditionals, so **every tier-dependent string is computed
in TypeScript** and passed as a variable. One helper, `tierPromptVars(task)` in
`src/lib/tier-prompt.ts` (new, pure), returns:

| Variable | Value |
|---|---|
| `tier` | `tierOf(task)` |
| `task_id` | `task.task_id` |
| `implement_model` | `IMPLEMENT_MODEL` |
| `review_model` | `REVIEW_MODEL` |
| `phase_loop` | the brief's numbered loop, built by walking `nextPhase` for the tier |
| `plan_status` | "cleared review" / "was not reviewed (tier `light`) — read it critically, and fix it first if it is wrong" |
| `review_count` | "Review cleared" / "Both review stages cleared" (for `merge.md`) |
| `light_review_note` | on light: "No plan review ran; judge the plan's soundness from the diff as well." Else `''` |

It is spread into the variables at **all three task render sites**, so no path can render a prompt
missing a token:

- `renderTaskPhasePrompt`'s `common` (`src/supervisor/tasks.ts:107-118`) — the supervisor's
  deliveries **and** `hpipe rewind`'s render (`src/cli.ts:630`), which goes through it. This also
  gives `research.md` the `task_id` it now references; without it `hpipe rewind … research` would
  throw.
- `renderWorkerPrompt`'s `vars` (`src/lib/worker-prompt.ts:19-31`) — the brief and the research
  prompt shipped with it, for `hpipe task`, `hpipe brief` and `dispatch --task`.
- `renderRunPhasePrompt`'s `common` (`src/supervisor/deliver.ts:410-415`) gets `review_model` and
  `task_tiers` (`t1 light, t2 heavy, …`) for `branch-review`.

### `prompts/implement.md` — the worker delegates the coding

The Opus worker keeps judgment; one Sonnet subagent writes the code.

1. **Triage (worker).** On a `BLOCKER` round, read the newest review and decide which findings to
   accept; rejected ones are answered in the PR body (existing rule).
2. **Dispatch (worker).** One subagent with `model: {{implement_model}}`. **Wait for it within this
   turn** — the same rule and reason as the review prompts: a backgrounded subagent leaves the pane
   reading idle while work is in flight. The subagent's brief is written out in the prompt, verbatim
   for the worker to carry, and contains:
   - the plan path, and the accepted findings if any;
   - the scoped guide to read first: `{{agent_file}}`, outranked by the repo's root `CLAUDE.md`;
   - work only in this worktree, only on `{{branch}}`; never commit to or push the default branch;
   - **re-read every file before editing it** (moved here from the worker: the subagent is the one
     editing; a sibling task may have landed changes while this one waited);
   - the TDD and one-commit-per-step rules the prompt carries today;
   - it cannot ask decisions: on a choice it should not make alone, stop and return the question to
     the worker, which raises it with `{{hpipe}} decide` as the brief already describes.
3. **Continue (worker).** If the subagent returns with steps unfinished, dispatch a fresh one starting
   at the first unfinished step. If it returned a question, raise the decision and end the turn.
4. **Verify and ship (worker).** Run tests and typecheck, read their output, open the PR
   (`Closes #n`), push.
5. **Fallback.** If a dispatch is rejected for its model, dispatch without it and say so in the PR
   body.

The prompt's first line uses `{{plan_status}}`.

### `prompts/ci-red.md` — same delegation

A task re-entering `implement` from `ci` gets `ci-red.md`, not `implement.md`
(`src/supervisor/tasks.ts:139-143`). It gains the same dispatch step: the worker reads the failure
(`gh run view --log-failed`, as today), decides whether it is environmental (re-run the check, no
code) or a defect, and for a defect dispatches the Sonnet subagent with the failing output and the
same scoping brief as above. The scoping block is identical text in both prompts; §5 tests that both
carry it.

### Review prompts

`spec-review`, `plan-review`, `pr-review-intent`, `pr-review-quality`, `pr-review` and
`branch-review` add `model: {{review_model}}` to their existing "dispatch the reviewer as a subagent"
step, with the same fallback: if rejected for its model, dispatch without it and note it at the top of
the review. Each reviewer brief asks the reviewer to open its file with `Tier: {{tier}}`
(`branch-review`: `Tiers: {{task_tiers}}`), so the next BLOCKER-rate tally can split by tier. Trailer
rules are unchanged; the `Tier:` line is at the top and cannot be mistaken for the trailer.

### `prompts/pr-review.md` — the combined review (new)

Same frame as `pr-review-intent.md`: fresh-context subagent, the reserved verdict path, wait within
the turn, commit and push the verdict, the head-sha rule. The brief has two mandatory sections,
**Intent** (the `pr-review-intent` checks, verbatim) then **Quality** (the `pr-review-quality`
checks, verbatim), one ranked findings list, one trailer, and `{{light_review_note}}`.

### `prompts/worker-brief.md`

- The numbered loop (`:24-30`) becomes `{{phase_loop}}`.
- The paragraph at `:37` that names `plan-review` becomes tier-neutral: "Before `implement` you may
  wait — …". Its re-read rule stays, rephrased: the subagent re-reads before editing, and the worker
  re-reads to triage findings and to brief it.
- A line: never lower your tier; raise it with `{{hpipe}} tier` when research shows it is too low.

### `prompts/merge.md`

"Both review stages cleared" → `{{review_count}}`.

### Docs

README and `skills/herdr-pipeline`: the tier table, `--tier`, labels, `hpipe tier`, the model split,
"run Claude with Opus as the default model", and "restart the supervisor after upgrading".

## 4. `branch-review` skip

`advanceRun`, case `execute` (`src/lib/machine.ts:71-76`). `RunSignals.anyTaskDone` becomes
`landedTaskCount`: tasks in `done` **or `orphaned`** — both are reachable only after merge
(`src/lib/phases.ts` comment above `failed`), so both put code on the branch.

- ≥ 2 landed → `branch-review` (as today).
- exactly 1 → run `done`, `why: 'one task landed; branch-review skipped'`.
- 0 → `escalated` (as today).

`execute`'s `stallWhen` is unaffected: it tests terminal-or-settled, not landed.

## 5. Tests

Table invariants (`test/table.test.ts`), for each tier:

- the `nextPhase` walk from `queued` reaches `ci`, passing through `implement`;
- no row that is any row's `onBlocker` has `tiers`;
- every row the tier reaches that has an `actor` has a `prompt`;
- **every verdict row is advanced**: for each row with `signal: 'verdict'`, `advanceTask` with an
  idle actor, fresh artifact and a `CLEAR` verdict returns a task in `nextPhase(tier, row)` — this
  catches a review case missing from `machine.ts:197-200`.

Unit:

- `nextPhase` for every (tier, row);
- `advanceTask` per tier, including `implement → pr-review` (light, standard) vs
  `implement → pr-review-intent` (heavy);
- a ledger task without `tier` routes as `heavy`, and is not written back;
- `hpipe tier`: raise; lower refused from the orchestrator pane and from a worker pane, allowed from
  another pane; no-op; terminal refused; `--why` required; `tier_history` entry shape; **no**
  `run.history` entry;
- registration: label beats `--tier`; two tier labels refused; unknown suffix refused; `gh` failure
  falls back; each printed `tier:` line; `readLabels` called once across a stale-save retry;
- `branch-review` skip at 0, 1 and 2 landed, with 1 = one `done`, and 1 = one `orphaned`;
- `formatTaskDetail` prints `tier`, `tier log`, `visited`; the status task line carries the tier;
- **render coverage**: for a fixture task in each tier, render every task-phase prompt through
  `renderTaskPhasePrompt` (the rewind path), the brief and research through `renderWorkerPrompt`, and
  `branch-review` through `renderRunPhasePrompt`; none throws and none contains a `{{`;
- rendered content: the brief's loop per tier (no `plan-review` on light); `plan_status` and
  `review_count` wording per tier; `model:` in `implement.md`, `ci-red.md` and every review prompt;
  the scoping block in both `implement.md` and `ci-red.md`; `Tier:` in each reviewer brief;
- `pr-review` in `REVIEW_PROMPTS`/`ALL` and `WORKER_REVIEW_PROMPTS`, so the existing trailer and
  "wait within this turn" contract tests cover it.

Live smoke run against `victorstein/hpipe-smoke`, per the project's practice, after restarting the
supervisor on the new build:

- **Batch A** — one light, one standard, one heavy issue. Check each task's `visited:` line in
  `hpipe show --task`; the implement subagent ran on Sonnet (worker pane or transcript); `Tier:` atop
  each verdict file; `branch-review` runs.
- **Batch B** — one light task, raised to standard by `hpipe tier` after research. Check the raise
  in `tier log:`, `plan-review` in `visited:`, and `branch-review` skipped.

## Out of scope

- Collapsing research, spec and plan into one artifact for light tasks. Measure after this ships.
- Cost or token accounting per phase.
- Tier-dependent models (e.g. heavy implementing on Opus): a small follow-up via the constants if
  Sonnet implementations of heavy tasks turn out weak.
- Closing the lowering guard's moved-pane gap (§2).

## Pass-1 findings

| Finding | Resolution |
|---|---|
| BLOCKER 1 — CLI cannot read model config | models are constants in `src/lib/models.ts` (Decisions, §1) |
| MAJOR 1 — typechecker claim false; `advanceTask` list missing | claim removed; explicit site table (§1); verdict-row advance invariant (§5) |
| MAJOR 2 — CI fixes bypass the subagent | `ci-red.md` gains the delegation step (§3) |
| MAJOR 3 — subagent lacks scoping rules | scoping block in the subagent brief; re-read rule moved to it (§3) |
| MAJOR 4 — no render-site plan; rewind throws | `tierPromptVars` spread at all three render sites; render-coverage test (§3, §5) |
| MAJOR 5 — no `hpipe show` timeline; `run.history` breaks `enteredByRewind` | `visited:` and `tier log:` in `hpipe show`; tier changes kept out of `run.history` (§1, §2) |
| MINOR 1 — `orphaned` not counted | counted as landed (§4) |
| MINOR 2 — moved/rebound panes pass the guard | stated as a known, accepted gap (§2) |
| MINOR 3 — `--model opus` may drop `[1m]` | worker pane not pinned (Decisions) |
| MINOR 4 — `by` shape ambiguous | `TierChange` typed (§1) |
| MINOR 5 — label read not memoised | memoised on `RegistrationAttempt`, injected `readLabels` (§2) |
| MINOR 6 — status format clash | exact format given (§2) |
| MINOR 7 — hand-maintained test lists | in the site table and tests (§1, §5) |
| MINOR 8 — on-disk format change unstated | stated at the top; restart in docs |
| MINOR 9 — review fallback; citation | fallback stated for reviews (§3); `tasks.ts:120-130` |
