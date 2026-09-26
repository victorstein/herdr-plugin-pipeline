# Review tiers and model routing — design

Written against `main` at `338e09a`. Two changes, specified together because both are expressed as
per-phase properties of the task table and both land in the same rendered prompts:

1. **Review tiers.** Each task carries a tier — `light`, `standard` or `heavy` — that decides which
   review phases it runs. Today every task runs all four review stages.
2. **Model routing.** Judgment work stays on Opus; the code-writing in `implement` moves to a Sonnet
   subagent. Today nothing pins a model: workers start with
   `herdr agent start … --kind claude -- --dangerously-skip-permissions` (`src/lib/unstarted.ts:92`,
   `prompts/dispatch.md:11`) and every phase and reviewer inherits the user's default.

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
| `branch-review` | skipped when at most one task reached `done` |
| Models | orchestrator, worker session, every reviewer: Opus. The `implement` subagent: Sonnet |
| How `implement` gets Sonnet | the Opus worker dispatches the coding to a subagent with `model: sonnet`; the pane's model is never switched |

| Tier | `spec-review` | `plan-review` | PR review |
|---|---|---|---|
| `light` | ✓ | – | combined `pr-review` |
| `standard` | ✓ | ✓ | combined `pr-review` |
| `heavy` | ✓ | ✓ | `pr-review-intent` then `pr-review-quality` (today's pipeline) |

Switching the pane with `/model` was rejected: it drops the prompt cache and is a keystroke into a
pane with no reliable confirmation — the class of delivery bug several live runs already hit.

## 1. Data model and routing

### Task record (`src/lib/types.ts`, `Task`)

    tier?: Tier                      // 'light' | 'standard' | 'heavy'
    tier_history?: TierChange[]      // { at, from, to, by, why }

Both optional so ledgers written before this change still parse. One reader, `tierOf(task)`, returns
`task.tier ?? 'heavy'`: an in-flight run keeps today's behaviour across an upgrade. New registrations
always write `tier` (default `standard`) and a first `tier_history` entry with `from: null`.

`by` is the caller's pane id and a role: `orchestrator`, `worker`, or `other` (see §2).

### Phase table (`src/lib/phases.ts`)

- `TaskPhase` gains `'pr-review'`.
- A new row between `implement` and `pr-review-intent`:

      { phase: 'pr-review', actor: 'worker', signal: 'verdict',
        onClear: 'pr-review-intent', onBlocker: 'implement', counter: 'pr-review',
        prompt: 'pr-review', stallable: true, holdsFiles: true, tiers: ['light', 'standard'] }

- `implement.onClear` becomes `'pr-review'`.
- `PhaseRow` gains `tiers?: readonly Tier[]` (absent = every tier) and `model?: 'implement' |
  'review'` — a role, not a model name, resolved through config (§3) so the table holds no model ids.
- `tiers`: `plan-review` → `['standard', 'heavy']`; `pr-review-intent`, `pr-review-quality` →
  `['heavy']`. Every other row has none.
- `model`: `implement` → `'implement'`; `spec-review`, `plan-review`, `pr-review`,
  `pr-review-intent`, `pr-review-quality` → `'review'`; run row `branch-review` → `'review'`.

### Routing

One resolver, pure, in `src/lib/phases.ts`:

    export function nextPhase(tier: Tier, from: PhaseRow<TaskPhase>): TaskPhase

Starting at `from.onClear`, it follows `onClear` while the landed-on row's `tiers` excludes `tier`,
and returns the first row the tier includes. It throws if the walk runs off the table (a table bug,
caught by §4's invariant test). `onBlocker` targets (`spec`, `plan`, `implement`) are never tiered,
so blocker routing is unchanged.

Every forward read of a **task** row's `onClear` goes through it:

- `advanceLoopingRow` on clear (`src/lib/machine.ts:167-168`) and the `research`/`spec`/`plan` case
  (`:184-187`);
- the `implement` case, which hard-codes `'pr-review-intent'` today (`src/lib/machine.ts:194`);
- `workerStillNeeded`'s reachability walk (`src/supervisor/tick.ts:149`);
- the worker brief's phase loop (§3).

The `queued → research` reads (`src/cli.ts:353,510,623,714`, `src/lib/unstarted.ts:52,149,192`,
`src/lib/worker-prompt.ts:34`, `src/supervisor/tasks.ts:207`, `src/lib/machine.ts:98`) stay on raw
`onClear`: `research` is untiered, and routing them through the resolver would change nothing.

A tier change needs no special case: the next forward step reads the current tier.

### Rewind

`hpipe rewind` onto a row the task's tier excludes is allowed — a human is being explicit — and prints
`warning: <phase> is not in tier <tier>; the task will leave it by the <tier> route`. Forward travel
from there follows the tier.

## 2. Setting and changing the tier

### At registration

`hpipe task … [--tier light|standard|heavy]`.

- Registration makes one `gh issue view <n> --json labels` call (for `--title`/`--body-file`, the
  freshly filed issue has no labels and the call is skipped).
- Exactly one `pipeline:tier-<name>` label wins over `--tier`. Two or more tier labels: registration
  exits non-zero naming them, nothing is recorded.
- An unknown `--tier` value or unknown label suffix (`pipeline:tier-huge`): exit non-zero.
- `gh` failure: fall back to `--tier` (else `standard`) and continue.
- `hpipe task` prints one line, always:

      tier: light (label pipeline:tier-light; --tier said standard)
      tier: standard (--tier)
      tier: standard (default)
      tier: heavy (--tier; labels unreadable: <reason>)

- Labels are read at registration only. The supervisor does not poll them: a `gh` call per task per
  tick is not worth it for an override the human can make with `hpipe tier`.

### Mid-run

`hpipe tier --task <id> <tier> --why "<reason>"`, a new subcommand, retried on a stale ledger like
the others (`retryingOnStale`).

- `--why` is required.
- **Raise**: allowed from any pane.
- **Lower**: refused when `HERDR_PANE_ID` equals `run.orchestrator_pane` or any task's `pane_id` /
  `last_pane_id` in that run, with: `lowering a tier needs a human; run this from your own pane`.
  This is a guard against an agent talking a task down, not authentication.
- Same tier: no-op, exit 0, nothing appended to `tier_history`.
- Terminal task (`done`, `failed`, `orphaned`, `blocked-on-failure`): refused.
- The change appends to `tier_history` and to `run.history` (`from: <old tier>`, `to: <new tier>`,
  `why`), so the timeline in `hpipe show` carries it.

**The phase the task is in always completes.** A tier change never interrupts it; only the next
forward step changes. A heavy task lowered to light while in `pr-review-intent` finishes that review,
then skips `pr-review-quality` to `ci`. A light task raised to heavy while in `pr-review` finishes it,
then runs `pr-review-intent` and `pr-review-quality`. A raise after a skipped `plan-review` does not
go back to it; `hpipe rewind` does.

A decision (`blocked-on-decision`) returns to `decision_from` as today; the step after reads the new
tier.

### Who is told to raise

- `prompts/research.md`: if research shows the task is bigger than its tier — another surface, a
  contract, a migration — run `hpipe tier --task <id> <higher> --why …` before writing the spec.
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

- `hpipe status` task lines: `t2 [light] implement …`.
- `hpipe show --task`: `tier:` line and the `tier_history` entries.

## 3. Prompts and models

### Configuration (`src/lib/config.ts`)

Three string keys, defaulted and read from `config.env` like `GH_BIN`:

| Key | Default | Used by |
|---|---|---|
| `WORKER_MODEL` | `opus` | the worker `agent start` line |
| `IMPLEMENT_MODEL` | `sonnet` | rows with `model: 'implement'` |
| `REVIEW_MODEL` | `opus` | rows with `model: 'review'` |

Aliases resolve to the newest model in each family, so a model release needs no change here. A value
is passed through as-is; a bad one surfaces where it is used (the worker's start, or the subagent
dispatch fallback below).

### Worker start

`startAgentCommand` (`src/lib/unstarted.ts:91-93`) becomes
`herdr agent start <name> --kind claude --pane <pane> -- --dangerously-skip-permissions --model <WORKER_MODEL>`.
It is the one spelling both `hpipe task`'s `dispatch, in order:` block and the `Dispatch tN …` prompt
render; `prompts/dispatch.md:11` shows it literally and is updated to match. `--model opus` carries no
shell metacharacters, so herdr's argument check accepts it.

The orchestrator is the human's own `hpipe start` pane; the plugin cannot set its model. README and
the `herdr-pipeline` skill say to run it on Opus.

### `prompts/implement.md` — the worker delegates the coding

The Opus worker keeps judgment; one Sonnet subagent writes the code.

1. Re-read every file the plan touches (existing rule). On a `BLOCKER` round, decide which findings
   to accept; rejected ones are answered in the PR body (existing rule).
2. Dispatch **one** subagent with `model: {{implement_model}}`, handing it the plan path, the
   accepted findings (if any), and the TDD / one-commit-per-step rules the prompt carries today.
   **Wait for it within this turn** — the same rule and the same reason as the review prompts: a
   backgrounded subagent leaves the pane reading idle while work is in flight.
3. If it returns with steps unfinished, dispatch a fresh one starting at the first unfinished step.
4. The worker itself runs tests and typecheck, reads their output, opens the PR (`Closes #n`), and
   pushes.
5. If the dispatch is rejected for its model, dispatch without it and say so in the PR body. The run
   does not stop over a model setting.

CI red already routes back to `implement` (`ci` row `onBlocker`), so CI fixes take the same path.

On `light`, line 3's "cleared review" is replaced by: the plan was not reviewed (tier `light`); read
it critically before handing it off, and fix it first if it is wrong.

### Review prompts

`spec-review`, `plan-review`, `pr-review-intent`, `pr-review-quality`, `pr-review` and
`branch-review` add `model: {{review_model}}` to their existing "dispatch the reviewer as a subagent"
step. Each reviewer brief also asks the reviewer to open its file with a line `Tier: {{tier}}`
(`branch-review`: `Tiers: t1 light, t2 heavy, …`), so the next BLOCKER-rate tally can split by tier.
The trailer rules are unchanged: the `Tier:` line is at the top and cannot be mistaken for it.

### `prompts/pr-review.md` — the combined review (new)

Same frame as `pr-review-intent.md`: fresh-context subagent, the reserved verdict path, wait within
the turn, the rules about head sha. The brief has two mandatory sections, **Intent** (the
`pr-review-intent` checks, verbatim) then **Quality** (the `pr-review-quality` checks, verbatim), one
ranked findings list, one trailer. On `light` the brief adds: *no plan review ran; judge the plan's
soundness from the diff as well.*

`src/supervisor/tasks.ts` gains a `pr-review` case in both prompt switches (`:123-128`, `:365-367`).

### Tier-aware text

- `prompts/worker-brief.md`'s numbered loop is rendered from the table by walking `nextPhase` for the
  task's tier, not hard-coded. A light worker is never told about `plan-review`.
- `prompts/merge.md` ("Both review stages cleared") says "Review cleared" for light and standard.

### Docs

README and `skills/herdr-pipeline`: the tier table, `--tier`, labels, `hpipe tier`, the three model
keys, and running the orchestrator on Opus.

## 4. `branch-review`, edge cases, testing

### `branch-review` skip (`advanceRun`, case `execute`, `src/lib/machine.ts:71-76`)

`RunSignals.anyTaskDone` becomes `doneTaskCount`.

- ≥ 2 tasks `done` → `branch-review` (as today).
- exactly 1 → run `done`, `why: 'one task landed; branch-review skipped'`.
- 0 → `escalated` (as today).

A task that ended `failed` or `escalated` does not count: nothing of it merged.

### Edge cases

- **Counters and verdicts.** `pr-review` gets its own `passes` and `verdict_seq` key through the
  existing generic code; paths come out `issue-N-pr-review-K.md`. `MAX_PASSES` binds per row, as now.
- **Exhaustive lists.** `PHASES_BEFORE_A_PR` (`src/cli.ts:204-206`) is unchanged — `pr-review` comes
  after a PR. Every `Record<TaskPhase, …>` and phase-ordering list picks `pr-review` up through the
  union; the typechecker flags any it misses.
- **Old ledgers.** `tier` absent → `heavy` via `tierOf`; nothing is written back until the task's
  tier is changed.

### Tests

Table invariants (`table.test.ts`), for each tier:

- the `nextPhase` walk from `queued` reaches `ci`, passing through `implement`;
- no row that is any row's `onBlocker` has `tiers`;
- every row the tier reaches that has an `actor` has a `prompt`;
- every row with `model` has an `actor`.

Unit:

- `nextPhase` for every (tier, row);
- `advanceTask` per tier through each review row, including `implement → pr-review` vs
  `implement → pr-review-intent`;
- a ledger task without `tier` routes as `heavy`;
- `hpipe tier`: raise; lower refused from the orchestrator pane and from a worker pane, allowed from
  another pane; no-op; terminal refused; `--why` required; history entries written;
- registration: label beats `--tier`; two tier labels refused; unknown suffix refused; `gh` failure
  falls back; the printed `tier:` line in each case;
- `branch-review` skip at 0, 1 and 2 done tasks;
- rendered prompts: the brief's loop per tier; the light wording in `implement.md` and `merge.md`;
  `model:` in the implement and every review prompt; `--model` on the start line; `Tier:` in each
  reviewer brief.

Live smoke run against `victorstein/hpipe-smoke`, per the project's practice:

- **Batch A** — one light, one standard, one heavy issue. Check each task's visited phases in
  `hpipe show`; `--model opus` on the printed start line; the implement subagent ran on Sonnet (worker
  pane or transcript); `Tier:` atop each verdict file; `branch-review` runs.
- **Batch B** — one light task, raised to standard by `hpipe tier` after research. Check the raise
  lands in `tier_history`, `plan-review` runs, and `branch-review` is skipped.

## Out of scope

- Collapsing research, spec and plan into one artifact for light tasks. Reviews were the question;
  artifact count is a separate one, best measured after this ships.
- Cost or token accounting per phase.
- Tier-dependent models (e.g. heavy implementing on Opus). The table's `model` role makes it a small
  follow-up if Sonnet implementations of heavy tasks turn out weak.
