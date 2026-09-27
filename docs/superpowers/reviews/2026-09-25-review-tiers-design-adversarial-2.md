# Adversarial review: review tiers and model routing design, pass 2

Spec: `docs/superpowers/specs/2026-09-25-review-tiers-and-model-routing-design.md` (branch
`docs/review-tiers-design`, pass 2, written against `338e09a`). Pass 1:
`docs/superpowers/reviews/2026-09-25-review-tiers-design-adversarial-1.md`.

I take the Decisions table as given. Part 1 checks each pass-1 resolution against the code. Part 2
reviews the surface this revision adds.

## Part 1: do the pass-1 resolutions hold?

| Pass-1 finding | Holds? | Evidence |
|---|---|---|
| BLOCKER 1 (CLI has no config) | **Yes** | Constants in `src/lib/models.ts` need no config on either side. The worker start line is no longer pinned, so `startAgentCommand`/`START_AGENT` (`src/lib/unstarted.ts:91-95`) stay as they are, and the import-time-constant problem goes away. |
| MAJOR 1 (typechecker claim; site list) | **Partly** | The site table is complete: a grep for `'spec-review'`/`'pr-review-intent'` outside `phases.ts` finds only `machine.ts:197-200`, `tasks.ts:123-130`, `tasks.ts:365-368` and `cli.ts:205`, and all four are accounted for. But the backstop test covers only one of the three silent sites. See MINOR 2. |
| MAJOR 2 (CI fixes bypass the subagent) | **Yes, for `ci-red`** | `ci-red.md` gets the delegation step. A third path into `implement` (resuming after an answered decision) is still not covered. See MINOR 1. |
| MAJOR 3 (subagent lacks scoping rules) | **In substance** | The scoping block is well chosen. But the text it names, `{{agent_file}}`, is not in the bag it renders from. See MAJOR 1. |
| MAJOR 4 (no render-site plan; rewind throws) | **Mostly** | `task_id` now reaches `research.md` through `common`, so `hpipe rewind … research` no longer throws. `{{hpipe}}` is injected by `renderPrompt` itself (`src/lib/render.ts:46`), so it resolves at every site. The one miss is `agent_file` (MAJOR 1). |
| MAJOR 5 (no timeline; `run.history` breaks `enteredByRewind`) | **Yes** | Keeping tier changes out of `run.history` leaves `enteredByRewind` (`src/lib/unstarted.ts:74-77`) correct. `formatTaskDetail` already takes `run` (`src/lib/status.ts:451`). Nothing trims `run.history` (it is only pushed to, and read at `unstarted.ts:75` and `ledger.ts:263`), so `visited:` is feasible. How `visited:` is formatted is left open. See MINOR 4. |
| MINOR 1 (`orphaned`) | **Rationale is false** | See MINOR 3. |
| MINOR 2 (moved-pane gap) | Yes | Stated as an accepted gap. |
| MINOR 3 (`--model opus` may drop `[1m]`) | **Moved, not closed** | The worker is no longer pinned, but every reviewer now is. See MINOR 5. |
| MINOR 4 to 9 | Yes | `TierChange` is typed. The memo on `RegistrationAttempt` fits `cmdTask`'s `outcome` pattern (`src/cli.ts:410-420`). The status format is exact. The test lists are named. The on-disk change and the restart are stated. The citations are corrected. |

Other checks against the code that hold:

- `nextPhase` is safe inside `workerStillNeeded` (`src/supervisor/tick.ts:141-157`). Every row before
  `ci` has `actor: 'worker'`, so the walk returns `true` before tiering can matter. It only calls
  forward from rows with an `onClear` (`:149`), so the "throws off the table" case cannot fire there.
- **Decision round trip from `implement`.** `blocked-on-decision` is orchestrator-owned with
  `holdsFiles: 'inherit'` (`src/lib/phases.ts:134-137`). The worker keeps the files, and
  `noteUncommittedWork` skips the row (`src/supervisor/tasks.ts:67`). `cmdDecide` refuses a second
  open decision (`src/cli.ts:799-801`). The subagent → worker → `hpipe decide` hand-back therefore
  lands the same way a worker-raised decision does today.
- **Stall behaviour for a long Sonnet subagent.** It matches today's long review subagent: `implement`'s
  `pr` signal escalates (`src/supervisor/stall.ts:18`), and escalation is held while the actor reads
  `working`, up to `STALL_PROBE_MAX` holds (`stall.ts:512-518`). "Wait within this turn", including
  the sequential re-dispatch in step 3, keeps the pane `working` for the whole turn.
- **Tier changes racing the supervisor.** A `hpipe tier` write that lands mid-tick makes the
  supervisor's save stale. The tick is then re-evaluated from the fresh copy, which carries the new
  tier (`src/supervisor/main.ts:372-380`). No transition computed on the old tier is forced through.
- The existing test `a red CI yields the ci-red prompt` renders the real `ci-red.md` through
  `advanceTasks` (`test/tasks.test.ts:324-332`). The render-coverage test only goes through the
  rewind path (`cameFrom = task.phase`, `src/cli.ts:630`), which never reaches `ci-red`, so this
  existing test is what covers it.

## Part 2: findings

### MAJOR 1: The scoping block names `{{agent_file}}`, but no bag that renders `implement.md` or `ci-red.md` carries it

**Claim (§3, Rendering plan).** `tierPromptVars` is spread into `renderTaskPhasePrompt`'s `common`,
"so no path can render a prompt missing a token". §3's `implement.md` step 2 writes the subagent
brief "verbatim" into the prompt. That brief includes "the scoped guide to read first:
`{{agent_file}}`". `ci-red.md` carries "the same scoping brief", as identical text (§3, `ci-red.md`).

**Problem.**

- `agent_file` exists in only one bag, `renderWorkerPrompt`'s local `vars`
  (`src/lib/worker-prompt.ts:25`).
- `renderTaskPhasePrompt`'s `common` has no `agent_file` (`src/supervisor/tasks.ts:107-118`).
- `tierPromptVars` as tabulated in §3 has no `agent_file` either: `tier`, `task_id`,
  `implement_model`, `review_model`, `phase_loop`, `plan_status`, `review_count`, `light_review_note`.
- Both `implement.md` and `ci-red.md` render from `common` (`tasks.ts:139-143`), so `render()` throws
  (`src/lib/render.ts:11`) on every path into `implement`:
  - the supervisor's `blocked-on-files → implement` delivery. The throw is caught per run and logged
    as "failed this tick" (`src/supervisor/main.ts:388`), then repeats every tick, so the transition
    never saves and the task sits in `blocked-on-files`;
  - a red CI;
  - `hpipe rewind … implement` (`src/cli.ts:630`), which throws in front of the operator.

This would not ship silently. The spec's render-coverage test renders `implement` through the rewind
path, and `test/tasks.test.ts:324` renders `ci-red`. That is why this is a MAJOR and not a BLOCKER.
But the spec as written fails its own test, and it leaves the implementer to decide where the
variable goes.

The same claim, "all three task render sites", also leaves out `decision.md`, which has a fourth bag
(`src/supervisor/tasks.ts:543-548`). The raise hint §2 adds there (`{{hpipe}} tier --task
{{task_id}} …`) resolves only because that bag happens to hold `task_id`. Any tier token in the hint
(for example "this task is `{{tier}}`") would throw on every decision announcement. No test renders
`decision.md` for a tiered task.

**Fix.**
- Add `agent_file` (and `surface`, for symmetry with the brief) to `tierPromptVars`, or to `common`.
  Say which.
- List `decision.md` as a render site and state that its hint uses only `{{hpipe}}` and
  `{{task_id}}`. Otherwise spread `tierPromptVars` there too and add it to the render-coverage test.

### MINOR 1: Resuming `implement` after an answered decision is a third path in, and it carries no delegation instruction

The pass-1 lesson was that entry paths into `implement` bypass the delegation. There are three
paths, not two:

- `implement.md`
- `ci-red.md`
- the `answer.md` resume

`markAnswerDelivered` re-enters `implement` and deliberately renders no phase prompt
(`src/supervisor/tasks.ts:452-455`). All the worker receives is `answer.md`: "Resume implement
applying this" (`prompts/answer.md:9`).

§3 step 3 says what to do when the subagent returns a question ("raise the decision and end the
turn"). It never says what to do when the answer comes back. The worker still has `implement.md` in
context, so it will probably re-delegate, but the path is unspecified. Two things are also left open:

- whether the subagent leaves uncommitted edits behind when it stops;
- whether the subagent or the worker pushes. `implement` has no `worked_on_answer` guard. Its
  `head_sha_at_entry` survives the decision round trip (`src/lib/machine.ts:93-110`, `:191`). So on
  a `BLOCKER` round, commits the subagent pushed before stopping can clear `implement` on the first
  idle read after the answer.

**Fix.** Extend step 3:
- On the answer, dispatch a fresh subagent from the first unfinished step, with the answer in its
  brief.
- The subagent commits but never pushes; the worker pushes in step 4.

### MINOR 2: The backstop covers `machine.ts` only; the other two silent sites can still be missed

§1 says the "table-driven test is the backstop" for sites the typechecker cannot see.

- **The "every verdict row is advanced" invariant** calls `advanceTask` directly. It never reaches:
  - `gatherSignals` (`src/supervisor/tasks.ts:365-368`). A missing `case 'pr-review'` there hits
    `default: return null` (`:402-403`), and the task never advances.
  - `renderTaskPhasePrompt`. A missing `case 'pr-review'` there returns `''` (`:154-155`).
- **The render-coverage test** asserts "none throws and none contains a `{{`", and `''` passes both.
  On the rewind path an empty prompt is silently "nothing owed" (`src/cli.ts:632`).

Either miss leaves every light and standard task idle in `pr-review` until the 45-minute probe.

**Fix.**
- Assert the rendered text is non-empty for every row that has `actor` and `prompt`.
- Add the verdict-row invariant at the `advanceTasks` level with a fake `verdictFor`, the way
  `test/tasks.test.ts:335-343` already drives `pr-review-quality`. Better still, key both switches on
  `row.signal === 'verdict'` and `row.prompt`.

### MINOR 3: `orphaned` is not "reachable only after merge"; counting it can declare a run with nothing landed `done`

§4 counts `orphaned` as landed because "both are reachable only after merge". The code says
otherwise:

- `hpipe rewind` accepts any task row (`src/cli.ts:655-659`).
- `status.ts:346-347` exists precisely because "a manual rewind can put an unmerged task in
  `orphaned`", and it guards on `merged_at_ms !== null`.

Take a run whose only non-failed task was rewound to `orphaned` unmerged. Today it escalates
("without one reaching done"). Under §4 it goes to `done`, "one task landed; branch-review skipped".
`done` reached by rewind has the same hole today.

**Fix.** Count `merged_at_ms !== null`, which is what pass 1 suggested and what `status.ts` already
trusts. Then drop the rationale sentence.

### MINOR 4: `visited:` is under-specified, and its own example does not match the history a light task writes

"The task's phases in order, read from `run.history` entries with its `task_id`" leaves open:

- **Which field.** A rewind entry is `from: 'rewind'` (`src/cli.ts:730`).
- **Duplicates.** A rewind that discards a pending answer, or abandons a decision, pushes a second
  entry with the same `to` (`:677-680`, `:694-697`).
- **Excursions.** It does not say whether `blocked-on-decision` or `escalated` excursions are shown.

The example `research → spec → spec-review → plan → implement → pr-review → ci` leaves out
`blocked-on-files`. Every task passes through that phase (`plan-review.onClear` today, and
`nextPhase(light, plan)` after this change). So the example implies a filter the text never states.
A rewind shown as a plain arrow (`implement → research`) also reads as a routing bug in exactly the
smoke check this line exists for.

**Fix.**
- Define it as each entry's `to`, in order, with consecutive duplicates collapsed.
- Mark rewinds (e.g. `⟲research`).
- Say whether `queued`, `blocked-on-files` and terminal phases are shown, and fix the example to
  match.

### MINOR 5: Pinning reviewers to `model: opus` reintroduces the context concern the spec used to reject pinning the worker

The Decisions table rejects `--model opus` for the worker because "the bare alias may select the
standard-context" Opus instead of the user's `[1m]` default. §3 then adds `model: {{review_model}}`
(`opus`) to every reviewer dispatch, `branch-review` included, which reads the whole branch. The
Decision ("every reviewer: Opus") is already met by inheritance: the README now requires Opus as
the default. The pin adds only this risk.

**Fix.** Do one of:
- Leave `model:` off the reviewer dispatch and keep `REVIEW_MODEL` for the `Tier:`/fallback text only.
- Keep the pin, and have Batch A check on a large diff that the reviewer subagent keeps the long
  context.

### MINOR 6: `plan_status`, `review_count` and `light_review_note` follow the current tier, not what actually ran

All three are computed from `tierOf(task)` (§3 table). §2 says a raise after a skipped `plan-review`
does not go back to it. In that case:

- `implement.md` tells the worker the plan "cleared review";
- `pr-review` gets no light note;
- a plan nobody reviewed is presented as reviewed.

The reverse case is less harmful but also wrong: a heavy task lowered to light after `plan-review`
cleared is told its plan "was not reviewed". `merge.md` has the same problem after a raise inside
`pr-review`, which then runs three review stages.

**Fix.** Derive these from what ran. A `plan-review-*` key in `task.artifacts.verdicts` is reserved
on entry (`src/supervisor/tasks.ts:95`, `src/lib/verdict-path.ts`), or read `run.history`.

### MINOR 7: Smaller gaps an implementer would have to guess

- **`phase_loop` must hold the literal relative paths.** `render()` is single-pass
  (`src/lib/render.ts:9`), so `phase_loop` has to embed the paths from `task.artifacts.*` (relative,
  as `worker-prompt.ts:27-29` does). It must not embed `{{research_path}}`, which would ship
  verbatim. Say so. The "no `{{`" assertion is currently the only thing that would catch it.
- **`ci-red.md` addresses the wrong reader.** It still says "Send the worker back to fix it"
  (`prompts/ci-red.md:7`), but it is delivered to the worker pane (`actorPane`,
  `src/supervisor/tasks.ts:176-178`, `:241`). The rewrite in §3 should address the worker directly.
  Otherwise the delegation step sits under a voice telling the reader to delegate to someone else.
- **Stale citation.** `formatTaskDetail` is `src/lib/status.ts:451-478`, not `:455-478`.

## Summary

- Every pass-1 BLOCKER and MAJOR is resolved in substance.
- Its new render bag has one real hole: `{{agent_file}}` is missing, which throws on every entry into
  `implement`. The spec's own render-coverage test and `test/tasks.test.ts:324` would catch it before
  it shipped. It is a one-line fix to the spec: add the variable to `tierPromptVars` or `common`.
- The rest are minors: an unspecified resume path, a backstop that is narrower than claimed, a false
  `orphaned` rationale, an underspecified `visited:` line, a reviewer model pin, tier-derived wording
  that can misstate what ran, and small prompt and citation fixes.
- Nothing here reverses a decision or needs the human. Counts: 0 BLOCKER, 1 MAJOR, 7 MINOR. The MAJOR
  is fixable in the spec.

VERDICT: CLEAR
