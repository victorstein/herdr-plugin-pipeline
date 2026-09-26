# Adversarial review: review tiers and model routing design, pass 1

Spec: `docs/superpowers/specs/2026-09-25-review-tiers-and-model-routing-design.md` (branch
`docs/review-tiers-design`, written against `338e09a`).

The product decisions are taken as given. This review checks whether the design implements them
correctly and completely against the code.

## What holds up

- Every `file:line` citation in §1 checks out: `machine.ts:98,167-168,184-187,194`, `tick.ts:149`,
  `unstarted.ts:52,91-93,149,192`, `worker-prompt.ts:34`, `tasks.ts:207`,
  `cli.ts:204-206,353,510,623,714`, `machine.ts:71-76`.
- `nextPhase` is correct as specified. I walked every (tier, row) pair by hand. For heavy,
  `implement → pr-review (excluded) → pr-review-intent`. For light, `plan → plan-review (excluded) →
  blocked-on-files` and `pr-review → intent (excluded) → quality (excluded) → ci`. A heavy task
  lowered to light while in `pr-review-intent` goes to `ci`. `onBlocker` targets are never tiered,
  so `advanceLoopingRow`'s `head_sha_at_entry` capture (`machine.ts:175`) is unaffected.
- Verdict reservation needs no change. The key is `${phase}-${seq}` and the filename is
  `issue-N-${phase}-K.md` (`verdict-path.ts:10-12,38-40`), so `pr-review-0` cannot collide with
  `pr-review-intent-0`. Nothing in `src/` prefix-matches review filenames.
- Old ledgers are safe to read. Nothing validates ledger JSON beyond `JSON.parse`
  (`store.ts:204`, `ledger.ts:245`), so the optional `tier`/`tier_history` parse, and `tierOf → heavy`
  keeps in-flight tasks on today's route.
- `herdr agent start … -- --dangerously-skip-permissions --model opus` is valid. `herdr agent start
  --help` takes `[-- [AGENT_ARG]...]`, and `claude --help` documents `--model <model>` as accepting
  the aliases `opus`/`sonnet` or a full name. The Agent tool's `model` parameter is an enum
  (`sonnet`/`opus`/`haiku`/`fable`), so `model: sonnet` is accepted. A full model id in
  `IMPLEMENT_MODEL` would be rejected, and the spec's fallback in §3 step 5 covers that.
- The `branch-review` skip is placed correctly. `advanceRun` case `execute` is the only place that
  picks `branch-review` (`machine.ts:71-76`). `RunSignals` is built in one place
  (`deliver.ts:299-309`), and the run's `execute` `stallWhen` does not read `anyTaskDone`.
- Probing a long implement subagent works the same as today's long implement turn. Probes are sent
  at `TASK_STALL_MINUTES`, and escalation is held while the actor reads `working`
  (`stall.ts:512-518`). The review prompts already depend on "wait within the turn" keeping the pane
  `working`.

## Findings

### BLOCKER 1: The CLI cannot read `WORKER_MODEL`/`IMPLEMENT_MODEL`/`REVIEW_MODEL`, and it renders most of the text that carries them

**Claim (§3, Configuration and Worker start).** The three keys are "defaulted and read from
`config.env` like `GH_BIN`". `startAgentCommand` becomes `… --model <WORKER_MODEL>` and "is the one
spelling both `hpipe task`'s `dispatch, in order:` block and the `Dispatch tN …` prompt render".

**Problem.** Only the supervisor processes load config: `supervisor/main.ts:147`,
`actions/supervisor.ts:21` and `startup.ts:161`, all through `HERDR_PLUGIN_CONFIG_DIR`. The CLI has
no config at all:

- `Ctx` is `{ stateDir, pluginRoot, session }` (`cli.ts:33`).
- Its state dir falls back to a hard-coded home path because herdr does not inject the plugin env
  into agent panes (`cli.ts:1003-1004`, `bin/hpipe` header comment).
- "Like `GH_BIN`" is exactly the precedent that fails: the CLI constructs `new Gh(undefined, …)`
  (`cli.ts:218-219`) and ignores `GH_BIN`.

Four CLI paths render model-bearing text:

- `hpipe task` prints `dispatchSequence` (`cli.ts:395-397`). The comment above it says this is the
  path "17 of the last 20 tasks" dispatch through.
- `hpipe rewind` renders the phase prompt through `renderTaskPhasePrompt`
  (`cli.ts:630`, `tasks.ts:104-157`). That prompt would now carry `{{implement_model}}` or
  `{{review_model}}`.
- `hpipe brief` and `hpipe show` render the brief (`cli.ts:447`), which will carry the tier-walked
  loop.
- Recovery text calls `startAgentCommand` through the module-level `START_AGENT` constant
  (`unstarted.ts:95`). It reaches `dispatchWorkerCommand`, `startWorkerCommand` and
  `remainingDispatchSteps`, which run from `stall.ts` probes, `status.ts` and `cli.ts:619-621`. A
  constant evaluated at import time cannot carry a config value.

Implemented as written, there are only two outcomes:

- The CLI hard-codes the defaults. A `WORKER_MODEL` override is then honoured only on the
  supervisor's gate-open path, a minority of dispatches, and the two paths the spec calls "one
  spelling" diverge.
- A render site passes no value and `render()` throws (`render.ts:11`) inside `hpipe rewind`, in
  front of the operator.

**Fix.**
- Give the CLI a config source. Either resolve `HERDR_PLUGIN_CONFIG_DIR ?? <herdr's config path for
  stein.pipeline>` beside the state-dir fallback at `cli.ts:1003` (verify the path live), or have
  `hpipe start` snapshot the resolved models onto the `Run` so both processes read the ledger.
- Thread the value into `startAgentCommand` and every caller of `START_AGENT`.
- Say which of the two options the design uses.
- Add tests that `hpipe task` and a supervisor gate-open print the same start line under a
  non-default `WORKER_MODEL`, and that `hpipe rewind` onto each review row and onto `implement`
  renders without throwing.

### MAJOR 1: "The typechecker flags any it misses" is false, and the spec leaves out `advanceTask`'s review case list

**Claim (§4, Exhaustive lists).** "Every `Record<TaskPhase, …>` and phase-ordering list picks
`pr-review` up through the union; the typechecker flags any it misses."

**Problem.** There is no exhaustive construct for the typechecker to flag:

- Every phase-keyed record is `Partial<Record<TaskPhase, …>>` (`types.ts:168,174`,
  `deliver.ts:359`).
- Every phase switch ends in `default: return null` or `''`: `machine.ts:244`, `tasks.ts:154,402`,
  `deliver.ts:431`.

§1 routes the `implement` case at `machine.ts:194` through the resolver. It never says to add
`'pr-review'` to the review case list at `machine.ts:197-200`. If that is missed, `advanceTask`
returns `null` for `pr-review` forever. The task sits until the stall ladder escalates it, for every
light and standard task, which is the default tier.

The spec does name `tasks.ts`'s two switches. It labels `:365-367` a "prompt switch", but it is
`gatherSignals`, and a miss there is silent in the same way (`default: return null`, `tasks.ts:402`).

The unit test "`advanceTask` per tier through each review row" would catch the `machine.ts` miss.
That is why this is a MAJOR, not a BLOCKER. But the spec's safety claim is exactly the kind of
reassurance the repo's memory ("DI hides wiring bugs") warns about.

**Fix.**
- Delete the typechecker claim.
- List the switch sites explicitly: `machine.ts:197-200`, `tasks.ts:120-156` and `tasks.ts:365-371`.
- Or better, make `advanceTask` and `gatherSignals` key on `row.signal === 'verdict'` rather than on
  a phase list, so a new verdict row cannot be forgotten.

### MAJOR 2: CI fixes do not take "the same path"; they get `ci-red.md`, which has no subagent step

**Claim (§3, `implement.md`).** "CI red already routes back to `implement` (`ci` row `onBlocker`),
so CI fixes take the same path."

**Problem.** The route is the same but the prompt is different. When `cameFrom === 'ci'`,
`renderTaskPhasePrompt` sends `ci-red.md`, not `implement.md` (`tasks.ts:139-143`). `ci-red.md`
(lines 1-11) says nothing about delegating, `model:` or waiting within the turn. The Opus worker
therefore writes the CI fix itself.

That contradicts the Decision that the `implement` coding runs on Sonnet. The spec's test list
("`model:` in the implement … prompt") would not notice, and neither would the smoke run.

**Fix.** Either:
- add the delegation step and `{{implement_model}}` to `ci-red.md`, and add it to the rendered-prompt
  tests, or
- state explicitly that CI fixes stay on the worker's model, as a deliberate exception.

### MAJOR 3: The Sonnet subagent that writes the code is never given the scoping rules that make the worker safe

**Claim (§3, implement steps 1-2).** The worker re-reads the files the plan touches. It then hands
the subagent "the plan path, the accepted findings, and the TDD / one-commit-per-step rules".

**Problem.** The rules that constrain code-writing are in the worker brief. A fresh subagent never
sees them:

- "Read `{{agent_file}}` before your first edit … Work only on this surface, only in this worktree,
  only on `{{branch}}`" (`worker-brief.md:10-12`).
- "Mirror the nearest existing example … surface a decision instead of inventing one", and
  "Conventional-commit messages. Never commit to `main`" (`worker-brief.md:62-66`).

The "re-read every file you are about to touch" rule exists because a sibling may have rewritten the
file while this task waited (`implement.md:5-8`, `worker-brief.md:37-40`). Step 1 applies it to the
worker, which no longer edits anything, not to the subagent that does. The subagent also cannot call
`hpipe decide`: it does not know the task id, and a decision raised mid-subagent is not "the last
action of your turn" for the pane.

**Fix.**
- Dispatch the subagent as `subagent_type: <surface>-dev`, which the registration check already
  guarantees exists (`cli.ts:271-274`). The Agent tool's `model` overrides the agent file's model.
- Put the branch/worktree/surface constraints, the re-read rule and "stop and report back rather
  than invent a pattern" into the handoff.
- Say that the worker, not the subagent, raises any decision.
- Add a rendered-prompt test that `implement.md` names `{{agent_file}}` or the surface agent.

### MAJOR 4: The new tokens and tier-dependent wording have no render-site plan; the rewind path throws

**Claim (§2, §3).** Several prompts gain tier- or model-dependent content:

- `research.md` gains `hpipe tier --task <id> <higher>`.
- Reviewer briefs gain `Tier: {{tier}}`, and `branch-review` gains `Tiers: t1 light, …`.
- `implement.md` line 3 and `merge.md` get light-only wording.
- `pr-review.md` "on `light` … adds" a sentence.
- The worker brief's loop is "rendered from the table".

**Problem.** `render()` only substitutes tokens and has no conditionals (`render.ts:8-14`). Every
tier-dependent sentence therefore has to be computed in TypeScript and passed as a variable, the
way `bootstrap_note` is. And every render site of that prompt has to pass it, or `render()` throws.
The spec names neither the variables nor the sites. The sites use different variable bags:

- `research.md` is rendered by `worker-prompt.ts:19-36`, whose vars include `task_id`. It is also
  rendered by `renderTaskPhasePrompt`'s `research` case with `common` (`tasks.ts:107-126`), which
  has no `task_id` and no tier.
- `hpipe rewind … research` reaches that second site through `cli.ts:630`, and a rewind to
  `research` is a path live runs use.
- So the natural implementation, `{{hpipe}} tier --task {{task_id}} …` in `research.md`, throws on
  every rewind to `research`.
- `branch-review` is rendered by `deliver.ts:420` with a bag that has no per-task data.
- `merge.md` is rendered with `common` (`tasks.ts:131-132`).
- `worker-brief.md` has a second hard-coded mention outside the numbered loop: "Between
  `plan-review` and `implement` you may wait" (`worker-brief.md:37`). This is wrong for light, and
  the spec only mentions the loop.

**Fix.**
- Name each new variable (`tier`, `tier_note`, `review_model`, `implement_model`, `phase_loop`,
  `task_tiers`).
- Add them once to `common` in `renderTaskPhasePrompt`, to `renderWorkerPrompt`'s vars and to
  `renderRunPhasePrompt`'s `common`.
- Add a test that renders every prompt name through every render site that can reach it, with the
  real template files. `worker-prompt.ts` and `renderTaskPhasePrompt` for `research`,
  `renderTaskPhasePrompt` for every task row, and `renderRunPhasePrompt` for every run row are the
  sites `test/prompts.test.ts` does not cover today.
- Fix `worker-brief.md:37`.

### MAJOR 5: Tier changes are "visible in `hpipe show`'s timeline", but there is no timeline, and the smoke plan's main check reads one

**Claim (§2).** The change appends to `run.history` "so the timeline in `hpipe show` carries it".
Batch A: "Check each task's visited phases in `hpipe show`".

**Problem.**
- `hpipe show --task` prints `formatTaskDetail` (`status.ts:455-478`): the current phase, artifacts,
  verdict keys, PR, CI, decision and notes. It prints no history and nothing reads `run.history` for
  display.
- The only readers of `run.history` treat it as phase transitions:
  - `enteredByRewind` takes the task's last entry and tests `from === 'rewind' && to === task.phase`
    (`unstarted.ts:74-77`).
  - `wasAborted` reads the run's last `why` (`ledger.ts:262-263`).
- A tier entry with `task_id`, `from: 'light'`, `to: 'standard'` becomes that task's last entry.
  After `rewind … research` on a paneless task followed by a `hpipe tier` raise, which is the
  sequence the research prompt now encourages, `overdueUndispatchedWorker` stops treating the task
  as entered by rewind. The orchestrator's probe then waits out `UNSTARTED_GRACE_MS` instead of
  firing on the next threshold (`unstarted.ts:79-83`).
- `HistoryEntry.from/to` are phase names everywhere else (`machine.ts:46,94`).
- The Batch A check "visited phases in `hpipe show`" cannot be done as written. That smoke run is
  the design's only proof that routing works live.

**Fix.**
- Keep tier changes out of `run.history`. `tier_history` already records them. Or give them a
  distinguishable shape, such as `from: 'tier:light'`, and make `enteredByRewind` skip them.
- Print `tier_history` in `hpipe show` as §2 already specifies.
- Either add a phase-history section to `hpipe show --task` or rewrite the smoke check to read the
  ledger JSON (`jq '.history[] | select(.task_id=="t1")'`) and the review files on the branch.

### MINOR 1: `doneTaskCount` ignores `orphaned`, although its stated rationale is merge

§4 says a `failed` or `escalated` task does not count because "nothing of it merged". `orphaned` is
"only reachable after merge … that code has already landed" (`phases.ts:144-147`,
`deliver.ts:361`). A run with one `done` and one `orphaned` task has two merged tasks but skips
`branch-review`. The Decision says "reached `done`", so this may be intended. If it is, drop the
merge rationale. If it is not, count `merged_at_ms !== null`.

### MINOR 2: The lowering guard misses panes whose id changed after the agent started

`HERDR_PANE_ID` is fixed in a process's environment when the process starts. `pane.moved` rewrites
`task.pane_id` to the new id without setting `last_pane_id` (`tick.ts:351-360`). A claim or rebind
rewrites `orchestrator_pane` (`orchestrator.ts:57,99`). After either, the agent's environment still
holds the old id, which matches neither recorded field, so it can lower a tier. The guard is
best-effort by design. Either record superseded ids (set `last_pane_id` on move, keep the previous
orchestrator pane) or say in the spec that the guard does not cover this.

### MINOR 3: `--model opus` may narrow the worker's context compared with the user's default

Today workers inherit the user's default model. If that default is a `[1m]` variant (this session
runs `claude-opus-5-5[1m]`), pinning the bare alias `opus` may select the standard-context variant.
A worker runs research through PR in one pane. Also, if someone sets `WORKER_MODEL=opus[1m]`, the
printed line needs quoting: `[…]` is a glob in the zsh the orchestrator pastes into, which fails with
"no matches found". Pass the value through `shellQuoted` (`unstarted.ts:87-89`), and check the alias
semantics live.

### MINOR 4: The `tier_history.by` shape is ambiguous

"`by` is the caller's pane id and a role" could be one string or `{ pane, role }`, and nothing says
what the registration entry records. Specify the type.

### MINOR 5: The label read inside `retryOnStaleRun` is not memoised

`registerTask` re-runs in full on a stale save (`cli.ts:402`). The spec's `gh issue view` call
should be memoised the way `fileIssueOnce` is (`cli.ts:393-395`), or placed outside the retry. It
also needs an injected dependency for tests, like `fileIssue`.

### MINOR 6: The status line format clashes with today's layout

Task lines are `  t2 <branch> #<n> [implement 5m] <agent> …` (`status.ts:421-431`). The spec's
`t2 [light] implement …` drops the branch and issue and puts a second bracket before the phase.
Pick one exact format, for example `[implement 5m] light`, and say whether `describeWake`,
`parkedFooter` and `catchUpDigest` (`tick.ts:60,88,103`) show the tier too.

### MINOR 7: The hand-maintained prompt lists in tests are not in the test plan

`REVIEW_PROMPTS`/`ALL` (`test/prompts.test.ts:9-16`) and `WORKER_REVIEW_PROMPTS`
(`test/table.test.ts:57`) are hand lists. "No orphan prompt files" will force `pr-review` into
`ALL`. Nothing forces it into the review lists, and those are what guard the trailer and the "wait
within this turn" / "Commit and push the verdict" contract for the new prompt.

### MINOR 8: The spec does not state that the phase table change is an on-disk format change

The repo's CLAUDE.md asks for this to be stated. A ledger with a task in `pr-review` makes
`taskRow` throw under any older build. That covers a rollback to an earlier tag, and a supervisor
process still running pre-upgrade code after `herdr plugin` upgrades the files under it. In the
second case the new CLI can also print a light brief while the old supervisor routes through
`pr-review-intent`. Say this, and say that the supervisor must be restarted after an upgrade.

### MINOR 9: The review-model fallback and a citation need tidying

- The "dispatch without the model if it is rejected" fallback is only stated for `implement`. Say
  whether the review prompts carry it too.
- `tasks.ts:123-128` should be `:120-130`.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 5
