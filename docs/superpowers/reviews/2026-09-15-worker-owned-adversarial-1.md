# Worker-owned pipeline (v5) — adversarial review 1

**Target:** `docs/superpowers/specs/2026-09-15-worker-owned-pipeline-design.md`
**Read against:** `specs/2026-09-13-herdr-pipeline-plugin-design.md` (v4), `reviews/2026-09-13-design-adversarial-{1,2,3}.md`,
and the implementation on `feat/plugin-implementation`.
**Date:** 2026-09-15

## Summary

The v5 thesis — move design work down to the agent that has read the code — is sound, and the
document is unusually honest about what it is trading away. Most of its claims about the existing
code check out: `nextDelivery` really does hardcode `run.orchestrator_pane`; `artifactPathFor`
really does assume every task artifact is a verdict; `HOLDS_FILES` really does live in `gating.ts`
with no import path to `machine.ts`; `TaskSignals` really does carry both `actorIdle` and
`workerIdle`; `worktree_created` really does carry a checkout path that `applyEvents` throws away;
and `advanceRun` really does carry one un-reset `run.pass` across three review phases. Those six
claims are verified below.

The design nevertheless does not survive contact with its own tables.

The headline defect is the fix for that last claim. `pass` reset "on every forward transition"
makes `MAX_PASSES` **unreachable** at all four worker review phases, because every entry to a review
phase is a forward transition. The spec sets out to fix a latent off-by-one and instead deletes the
only bound on the review loop — which is round 3's MAJOR 4, re-created by the fix for a different
instance of the same counter. Beside it sit four more BLOCKERs: a `close` row that is provably
unsatisfiable under the repo's own `Closes #n` convention (and is already a live bug in this repo's
auto-memory); an `execute` completion rule that is a level predicate over a task set the spec now
deliberately lets grow, so a run closes itself while the orchestrator is still filing tasks; a
delivery path that can address exactly one pane per tick and is now asked to address N worker panes;
and a `hpipe decide` called twice that writes `decision_from: "blocked-on-decision"`, producing the
one state in the machine with no inferred exit and no answer that leaves it.

Three recurring classes from the v4 rounds are present again: **level predicates presented as edges**
(`intake`, `dispatch`, `close`), **universal claims the document's own tables contradict** ("the only
path out of `blocked-on-decision`", "idle is the completion signal for every worker phase"), and
**fixing the instance, not the class** (round 3 MAJOR 6's one-prompt-per-digest problem, solved for
the orchestrator in v4 and re-introduced verbatim for workers).

Counts: 5 BLOCKER, 8 MAJOR, 5 MINOR.

---

# BLOCKERS

## BLOCKER 1 — The per-phase `pass` rule makes `MAX_PASSES` unreachable at every worker review phase. The four review loops have no bound.

**Location:** §Phase machine, "**`pass` resets on every forward transition.**" (spec:148-154), and
the `spec-review` / `plan-review` / `pr-review-intent` / `pr-review-quality` rows of the Task table
(spec:128-136).

**Claim:** "Entering a phase via `onClear` sets `pass = 0`; entering via `onBlocker` increments it.
… `MAX_PASSES` means passes *at this phase*, which is the only reading under which the number is
interpretable."

**Why it's wrong:** The stated mechanism is a single scalar reset on forward transitions. But every
entry to a review phase *is* a forward transition. Trace `spec-review` against the table's own rows:

| step | transition | kind | `pass` after |
| --- | --- | --- | --- |
| 1 | `research` → `spec` | onClear | 0 |
| 2 | `spec` → `spec-review` | onClear | **0** |
| 3 | verdict BLOCKER: is `pass >= MAX_PASSES`? `0 >= 2` → no | — | — |
| 4 | `spec-review` → `spec` | onBlocker | 1 |
| 5 | `spec` → `spec-review` | onClear | **0** |
| 6 | back to step 3, forever | | |

The counter is incremented on the phase the task *leaves toward* (`spec`, `implement`) and tested on
the phase it *enters* (`spec-review`, `pr-review-intent`), and the entry always resets it. Identical
traces hold for `plan` ↔ `plan-review` and for `implement` ↔ `pr-review-intent` ↔ `pr-review-quality`.
Only run-level `branch-review` survives, because its `onBlocker` target is itself.

The v4 implementation does not have this hole: `advanceTask` (`src/lib/machine.ts`) tests
`task.pass >= s.maxPasses` against a counter that is never reset, so the loop terminates. v5's
correction removes the bound it was correcting.

Two corollaries fall out of the same rule:

- The spec's own claim that "Verdict keys stay `<phase>-<pass>` within the task's own map, so pass 2
  cannot read pass 1's file" (§Artifacts, spec:243) is **false under the new rule**. `pass` at a
  review phase is permanently `0`, so every pass of `spec-review` writes and reads
  `spec-review-0`. Each review overwrites the previous one, and `isFresh` is the only thing keeping
  it honest.
- `hpipe rewind` is described as "unchanged semantics" (§CLI, spec:307). `cmdRewind` sets
  `task.pass = 1` / `run.pass = 1`. Under a base of 0 that silently spends one of `MAX_PASSES = 2`
  the moment a human rescues an escalation — the opposite of the stated intent ("so a human who
  answers an escalation is not immediately re-escalated", v4:§verdict contract).

**What breaks:** A task whose spec the reviewer keeps rejecting cycles `spec` ↔ `spec-review` until
a human notices. It never reaches `escalated`, so nothing surfaces it: `escalated` is what the digest
reports and what `hpipe status` flags. It holds its `files` reservation and its worktree the whole
time (BLOCKER 3 / MAJOR 1), so its dependents and file-overlapping siblings never dispatch. This is
round 3 MAJOR 4 ("A task that keeps failing review loops `execute ↔ task-review-*` forever")
restored.

**Smallest fix:** The counter has to be keyed by the phase it bounds, not carried as one scalar.
Replace `Task.pass: number` with `Task.passes: Partial<Record<TaskPhase, number>>`. A review row's
`onBlocker` increments `passes[reviewPhase]` and tests *that* value against `MAX_PASSES`; a review
row's `onClear` deletes `passes[reviewPhase]`; `hpipe rewind --task` clears the whole map. Render
`<phase>-<passes[phase]>` for the verdict key. Say explicitly in the doc that no transition into a
review phase ever resets that phase's own counter.

---

## BLOCKER 2 — The `close` row's edge predicate is unsatisfiable under the repo's own mandated `Closes #n` convention. Every task deadlocks after merge, and no run ever reaches `branch-review`.

**Location:** Task table, `close` row (spec:139): "`gh issue view --json closed` is true **and**
`closedAt > phase_entered_at`". Restated as preserved from v4 (spec:6-9).

**Claim:** Implicitly, that a task in `close` can complete.

**Why it's wrong:** The chain is forced:

1. `merge` completes only when `mergedAt > phase_entered_at(merge)` — so the supervisor observes the
   merge on some tick *after* `mergedAt`.
2. `enterTaskPhase(run, task, 'close', …)` sets `phase_entered_at = Date.now()`, which is strictly
   greater than `mergedAt`.
3. `prompts/task.md` (verified on `feat/plugin-implementation`) mandates a PR body ending
   `Closes #{{issue}}`, and calls "Implements #n" a failure. v5 keeps this: `worker-brief.md`
   "inherits from `task.md`: … and the `Closes #<n>` PR-body rule" (spec:222).
4. GitHub closes a linked issue **as a side effect of the merge**, so `closedAt ≈ mergedAt`.
5. Therefore `closedAt > phase_entered_at(close)` is false — `closedAt` predates phase entry by the
   full merge-detection latency. It is false on the first tick and on every tick after, because
   `closedAt` is immutable.

This is not theoretical. This repo's own project memory records it as a live defect
(`project-close-phase-deadlock-bug.md`: "close predicate requires closedAtMs > phase_entered_at,
unsatisfiable given the mandated Closes-#n merge convention; test masks it"). v5 restates the row
verbatim in its own table, which makes it v5's row.

`gh` field names are correct — I verified `gh issue view --json` exposes `closed` and `closedAt`, and
`gh pr view --json` exposes `state`, `mergedAt`, `headRefOid` and no `merged` (evidence in
§Verification). The names are right; the comparison is wrong.

**What breaks:** Every task stops permanently at `close`. It never reaches `teardown`, so its
worktree is never removed, its `files` reservation is never released (`HOLDS_FILES` includes
`close`), and its dependents never leave `queued`. `execute` requires *every* task terminal
(spec:104), so the run never reaches `branch-review` either. v5's `execute` row makes this worse than
v4: v4's implementation would at least have advanced the run when the remaining tasks settled.

**Smallest fix:** The edge for `close` is not "later than phase entry", it is "later than the merge
that should have caused it". Persist `merged_at_ms` on the task when `merge` completes, and make
`close`'s predicate `closed && closedAt >= merged_at_ms`. That is still an edge (a rewind to `merge`
re-captures `merged_at_ms`), and it is satisfiable by the auto-close path. Add a note that a task
whose issue is auto-closed passes `close` on the first evaluation by design, so the `close.md` prompt
must be delivered at `merge` → `close` entry or not at all.

---

## BLOCKER 3 — `execute` completes on a level predicate over a task set the spec deliberately lets grow. A run closes itself while the orchestrator is still registering tasks.

**Location:** Run table `execute` row (spec:104) plus the paragraph immediately below it,
"**`intake` advances on the first registration, not the last.**" (spec:110-114).

**Claim:** "The orchestrator may register more tasks at any later phase; a task registered during
`execute` enters `queued` and is gated normally. This is a capability the v4 machine did not have …
and it is what makes 'you report a problem mid-run' work."

**Why it's wrong:** `execute`'s predicate is "every task terminal". That is a pure level predicate
over a mutable set, and the spec has just removed the thing that used to make the set complete before
evaluation began (v4 required a cleared plan before any task existed). There is no "intake closed"
signal anywhere in v5. The implementation already evaluates exactly this rule every tick
(`src/supervisor/teardown.ts`: `run.phase === 'execute' && run.tasks.length > 0 &&
run.tasks.every((t) => SETTLED.has(t.phase))`), with `SETTLED` equal to v5's terminal set.

The race needs no exotic timing, because the orchestrator's registrations are spread across turns by
construction — `intake`'s predicate is *actor idle*, so registering a task and then ending the turn is
the normal path:

1. Turn 1: orchestrator registers `t1`, ends turn. `intake` → `dispatch` → (one worktree adopted) →
   `execute`.
2. `t1`'s `agent start` adoption fails, or its pane exits — `applyEvents` writes `failed`
   unconditionally, from any phase.
3. `runTeardown` sees `every(SETTLED)` → run leaves `execute`. Per v5, with no task `done`, → `escalated`.
4. Turn 2: orchestrator runs `hpipe task` for `t2`. `cmdTask` refuses: the run is neither `dispatch`
   nor `execute`. `escalated` is in `PANE_RELEASING_RUN_PHASES`, so `pickOneAdvance` skips the run
   entirely — nothing else will ever touch it.

The benign version is worse for the user: `t1` is small, finishes cleanly while the human is still
discussing `t2`, and the run advances to `branch-review` with one PR on the branch. The
`branch-review` prompt then "names every non-`done` task and its terminal phase" — an empty list —
and the run reaches `done` having shipped a third of the work.

**What breaks:** The one new capability §Problem is written to deliver ("you report a problem
mid-run") is the thing that breaks the run, on the most ordinary possible sequence of orchestrator
turns.

**Smallest fix:** Make intake closure explicit, exactly as `blocked-on-decision` is made explicit.
Add `run.intake_closed: boolean`, set by an `hpipe dispatch --done` (or `hpipe task --last`) call,
and make `execute`'s predicate `intake_closed && every task terminal`. Reopening it is `hpipe task`
itself: registering a task while the run is in `execute` sets `intake_closed = false` again. Keep
`cmdTask`'s accepted phases as `intake | dispatch | execute`.

---

## BLOCKER 4 — Delivery addresses one pane per tick and coalesces every prompt for a run into one message. v5 needs one message per actor pane, and the change list that claims to be complete does not mention it.

**Location:** §Code shape, "Three call sites change beyond the table" (spec:277-289), item 1.

**Claim:** "**`nextDelivery` / `evaluateRun`** take the pane from `row.actor` … instead of always the
orchestrator's."

**Why it's wrong:** That is not the shape of the problem. In the implementation:

- `DigestInput` is **per run**, carrying one `nextPrompt` string.
- `main.ts` concatenates every prompt produced in a tick — `evaluateRun`'s plus all of
  `advanceTasks`' — into one string joined by `\n\n---\n\n`, and hands it to one `DigestInput`.
- `nextDelivery(digests)` returns **one** `Delivery` for the whole tick, the first input with
  content, and every other input is discarded. Since `advanceTasks` has already mutated and saved the
  run, a prompt that loses that race is not regenerated next tick — it is lost.
- The message it builds is `[pipeline] run <id> → <phase>` + `N events:` + the prompt.

v4 made this safe with a rule v5 inherits unchanged ("Everything that document says about … event
transport … still holds", spec:6-9): "The supervisor advances at most one orchestrator-owned phase
per orchestrator per tick", which is round 3's MAJOR 6 fix. That rule works because in v4 every
prompt-producing row had the same recipient. In v5, eight of fifteen task rows are worker-owned and
each worker has its own pane, so a tick that advances `t1: research → spec`, `t2: plan-review →
implement` and `t3: pr-review-intent → implement` produces three prompts for three different panes.
The implementation will concatenate them and send the concatenation to whichever pane `row.actor`
resolved first — or, with `orchestrator_pane` still in `DigestInput`, to the orchestrator.

The same table-driven rule also cannot express the one delivery v5 needs most: `answer.md` goes to
the **worker** (§Prompts, spec:214) while `blocked-on-decision`'s `actor` is **orchestrator**
(spec:142). There is no row whose `actor` is the recipient of `answer.md`.

**What breaks:** Nothing routes correctly. In the best case a worker receives a digest header, two
other workers' review briefs and its own; in the common case two of the three prompts are silently
dropped and those tasks sit in a phase nobody was ever told to work.

**Smallest fix:** Change the unit. `nextDelivery` returns `Delivery[]`, grouped by target pane, never
joining prompts across panes; the `[pipeline] run … / N events:` header is attached only to the
orchestrator's message; per-pane retry counters replace the single module-level `attempts`. Restate
the v4 coalescing rule as "at most one advance **per actor pane** per tick", and add the `answer.md`
recipient as an explicit `resumePrompt`/`resumeActor` on the `blocked-on-decision` row rather than
leaving it to `actor`. Add this to the "three call sites" list, which is otherwise read as complete.

---

## BLOCKER 5 — A second `hpipe decide` on a blocked task writes `decision_from: "blocked-on-decision"`. Answering it returns the task to the one phase with no predicate and no inferred exit.

**Location:** §The decision channel → Surfacing, "The CLI appends to `task.decisions[]` and enters
`blocked-on-decision`, recording `decision_from: \"<current phase>\"`" (spec:184-185); §Resume,
"returns the task to `decision_from`" (spec:212).

**Claim:** "The explicit CLI call in and the explicit CLI call out are what make the state
unambiguous."

**Why it's wrong:** `decision_from` is written from the *current* phase with no guard. If the task is
already in `blocked-on-decision`, the current phase **is** `blocked-on-decision`, so `decision_from`
becomes `"blocked-on-decision"` and the record of where the work actually came from is destroyed.
`hpipe answer` then returns the task to `blocked-on-decision`. The row has no predicate by design, so
nothing ever moves it again; the only escape is `hpipe rewind --task`, and the human has to guess
which phase the task was in, because the field that held it has been overwritten.

The second call is not exotic. The spec itself asks the worker to surface "a choice that … changes
scope, that commits another surface to a contract" — a worker reaching a design fork with two open
questions writes two `hpipe decide` calls, and §Failure modes explicitly contemplates a worker that
"calls `hpipe decide` and keeps working". Nothing in §CLI says `hpipe decide` rejects a task that is
already blocked; `--recommend` is the only stated validation.

Even without the overwrite, two open decisions are underspecified: `hpipe answer --decision d1`
returns the task to `plan` with `d2` still open in `decisions[]`, `hpipe status` still lists it, and
the stall probe keeps probing the orchestrator about a decision the worker is no longer waiting on.

**What breaks:** A worker that asks two questions is permanently stuck, in a state the design
describes as the safe one precisely because it cannot be exited by inference.

**Smallest fix:** Two lines in `hpipe decide`: reject the call when `task.phase ===
'blocked-on-decision'`, naming the open decision id; and never write `decision_from` when the current
phase is `blocked-on-decision`. State in §Surfacing that a task carries at most one open decision and
that a worker with two questions must ask the more consequential one first.

---

# MAJORS

## MAJOR 1 — The `files` reservation now spans eight phases including three that touch no source, so overlapping tasks serialize their entire pipelines. The price is never stated.

**Location:** Task table `queued` row (spec:120), §Code shape `holdsFiles` row of the v4→v5 mapping
(spec:270), and §Non-goals "Changing the supervisor, hooks, queue, or session model. Untouched."
(spec:47).

**Claim:** Implicitly, that `queued`'s file gate is unaffected by the change.

**Why it's wrong:** In v4 a task held its `files` from `execute` — roughly implement + two reviews +
CI + merge + close. In v5 it holds them from `research` through `teardown`: research, spec,
spec-review, plan, plan-review, implement, two PR reviews, CI, merge, close, teardown, plus
`blocked-on-decision` (which the spec correctly says must hold them) and `failed`/`escalated` (which
`HOLDS_FILES` already includes and nothing ever tears down). A second task declaring an overlapping
`--files` prefix now waits through a full adversarial design cycle, not just an implementation.

Worse, five of those phases cannot possibly conflict. `research`, `spec`, `spec-review`, `plan` and
`plan-review` write only into `docs/superpowers/**`, in a *linked worktree on a separate branch*. The
gate exists for `CLAUDE.md:92-94` — two agents editing the same files — and is doing nothing during
those five phases except blocking a sibling that could have been researching in parallel. The design's
stated goal is "Fleet width then scales with worker count instead of with one context window"
(spec:32); the file gate now caps it at the number of non-overlapping `--files` declarations, over a
window several times longer than v4's.

Note that `--files` is a *declared-intent prefix heuristic* (v4:§Ordering and collisions), so two
tasks both declaring `packages/core/src/` is the normal case, not the pathological one.

**What breaks:** Not correctness — throughput, which is the entire justification for the redesign.
On the first live run with two overlapping tasks, worker 2 will sit in `queued` for the whole of
worker 1's research-through-merge, and the run will look exactly as serial as v4.

**Smallest fix:** This needs a decision, not a mechanical change, because simply setting
`holdsFiles: false` on the five design phases lets both tasks reach `implement` concurrently and
defeats the gate. Either (a) keep the gate at `queued` and state the cost plainly in §Failure modes
alongside "Six artifacts × N tasks", or (b) split the gate in two: leave `queued` gated only on
`depends_on`, and add a second overlap check on entry to `implement`, holding the task at
`plan-review`-clear until the overlap clears. (b) is the behaviour the design wants and is a
localized change to `gateStatus` plus one new holding state; it should be chosen or rejected
explicitly.

---

## MAJOR 2 — A worker-owned phase's stall probe targets a pane that does not exist yet. A task whose dispatch prompt was dropped sits in `research` forever with nobody to probe.

**Location:** Task table `queued` → `research` (spec:120); "**A `queued` task has no pane.**"
(spec:161-164); §Configuration, "`TASK_STALL_MINUTES` covers a silent worker in any worker-owned
phase, not only `implement`" (spec:333); §Code shape, "`stallable` is an explicit field" and "its
probe targets the orchestrator rather than the phase's worker" (spec:273-275).

**Claim:** "A task in `research` with `pane_id === null` is skipped by predicate evaluation each tick
— not an error, and not a stall until `TASK_STALL_MINUTES`."

**Why it's wrong:** The spec establishes that a probe goes to the row's actor, and singles out
`blocked-on-decision` as the exception that goes to the orchestrator instead. `research`'s actor is
`worker`, and the spec has just said the worker pane is `null` in exactly this state. So the probe for
the one condition it was extended to cover has no destination.

The condition is reachable without any exotic failure. `queued` → `research` fires one prompt to the
orchestrator carrying the worker brief. If that delivery hits `agent_blocked` five times
(`PROMPT_RETRY_MAX = 5`, at `TICK_MS = 1000` — five seconds of a blocked orchestrator), v4's rule is
that the supervisor "holds and reports in `status`". Nothing re-sends it. The task is now in
`research` with no pane, no prompt delivered, and no probe target.

v4 did not have this hole: `taskStallCandidates` gates on `run.orchestrator_pane` and `main.ts`
delivers the probe to `candidate.run.orchestrator_pane`, which is the right recipient for exactly
this failure — the orchestrator is the party who failed to dispatch.

**What breaks:** A silently undispatched task. It holds its `files` (MAJOR 1), blocks its dependents,
and keeps the run out of `execute`'s terminal check indefinitely. `hpipe status` shows it as
`research`, which reads as healthy.

**Smallest fix:** One sentence and one fallback: the stall probe resolves the row's actor pane, and
**falls back to `run.orchestrator_pane` when that pane is null** — the orchestrator is the only party
who can act on a task that has no worker. Make it a property of the probe, not a per-row exception,
so `blocked-on-decision` stops being a special case too.

---

## MAJOR 3 — "The only writers of `blocked-on-decision` and the only path out of it" is false against two components v5 says it preserves unchanged.

**Location:** §Code shape item 3 (spec:288-289).

**Claim:** "`src/actions/decide.ts` and `src/actions/answer.ts` are the only writers of
`blocked-on-decision` and the only path out of it."

**Why it's wrong:** Two preserved paths write over it:

1. `applyEvents` (`src/supervisor/tick.ts`) handles `pane.exited` and a released
   `pane.agent_detected` by calling `enterTaskPhase(run, task, 'failed', …)` **with no phase guard at
   all**. A worker whose pane dies while its decision is open goes straight to `failed` from
   `blocked-on-decision`. v5 keeps this (`research`/`spec`/`implement` rows: "pane exited or agent
   released → `failed`") and never carves out the blocked state.
2. `hpipe rewind --task <id> <phase>` writes any phase over any phase. §CLI says it "accepts the new
   task phases; unchanged semantics".

The consequences are unspecified, and the caller's questions land squarely on them:

- **Pane dies while blocked.** The task is `failed`; `decisions[]` still holds an unanswered entry;
  `hpipe status` "lists every open decision with its age" (spec:220) and will keep listing one that
  belongs to a dead task; the stall probe keeps nagging the orchestrator to answer it.
- **`hpipe answer` targets a task that already left the phase.** Nothing in §Resume says it refuses.
  As written it writes the answer, resets `phase_entered_at`, and returns the task to `decision_from`
  — resurrecting a `failed` task into `plan` with a dead `pane_id`, where it sits forever (no pane →
  skipped by predicate evaluation → MAJOR 2's unprobeable state).

**What breaks:** Open decisions outlive their tasks and pollute the orchestrator's triage queue; a
well-meaning `hpipe answer` silently resurrects dead work.

**Smallest fix:** (a) Reword the claim to "the only *predicate-driven* transitions into and out of
`blocked-on-decision`"; (b) on `pane.exited` / release while `blocked-on-decision`, mark every open
decision `answered_by: "abandoned"` as the task goes `failed`, so `hpipe status` and the stall probe
stop reporting it; (c) `hpipe answer` refuses a task not currently in `blocked-on-decision`, printing
its actual phase.

---

## MAJOR 4 — `hpipe decide` / `hpipe answer` are placed in `src/actions/`, which is the herdr plugin-action directory. `plugin.action.invoke` accepts no user arguments — a v4 verified fact.

**Location:** §Code shape item 3 (spec:288): "`src/actions/decide.ts` and `src/actions/answer.ts`".

**Claim:** That these two commands live beside `status.ts`, `claim.ts`, `drain.ts`, `supervisor.ts`.

**Why it's wrong:** `src/actions/` is not a general command directory. Every file in it is a
`[[actions]]` entry in `herdr-plugin.toml`, invoked from herdr's UI. v4's verified-facts table records
the constraint and the conclusion: "`plugin.action.invoke` accepts no user arguments (schema
`PluginActionInvokeParams`) → **Data goes through `hpipe`**." Both new commands take three or four
*required* string arguments. They cannot be herdr actions.

Meanwhile §CLI correctly lists them as `hpipe` subcommands. The document specifies two incompatible
homes for the same two commands.

**What breaks:** An implementer following §Code shape writes two files that are either dead (never
declared in the manifest) or declared and unable to receive `--question` / `--answer`. A round of
rework, and — given the v4 history of a verified fact being honoured in one place and violated in
another — exactly the class of defect this project keeps producing.

**Smallest fix:** `cmdDecide` and `cmdAnswer` in `src/cli.ts`, beside `cmdTask` and `cmdRewind`.
Delete the `src/actions/` reference.

---

## MAJOR 5 — "Worker calls `hpipe decide` and keeps working — wasteful, not incorrect" is incorrect. The answer can be permanently undeliverable while the phase advances anyway.

**Location:** §Failure modes, row 4 (spec:369).

**Claim:** "The phase is already `blocked-on-decision` with no predicate, so nothing advances on the
extra work; it is redone after the answer. Wasteful, not incorrect."

**Why it's wrong:** The reasoning covers the blocked interval and stops at the boundary. `hpipe
answer` delivers `answer.md` to the worker pane through the same gated path as everything else, which
means `herdr agent prompt`, which **rejects with `agent_blocked` before sending input** and is retried
"with backoff across ticks … up to `PROMPT_RETRY_MAX`, then holds and reports in `status`"
(v4:§Event transport). `PROMPT_RETRY_MAX` is 5 and `TICK_MS` is 1000. A worker that called
`hpipe decide` mid-turn and kept editing files — the exact worker this row describes — is `working`
for far longer than five ticks.

So: the answer is written to the record, the task is returned to `decision_from` with
`phase_entered_at` reset, delivery is abandoned, and the worker never learns the answer. It then
finishes the artifact it was writing all along, touches the file after the reset, and the freshness
predicate fires. The phase completes **with the answer unread** — which is the precise failure
§Resume says the `phase_entered_at` reset exists to prevent (spec:214-216). The reset does not prevent
it; it only delays it by however long the worker takes to touch the file once more.

**What breaks:** A decision the orchestrator escalated to the human, answered, and recorded in
`run.history` is silently not applied, and the audit trail says it was.

**Smallest fix:** Make the answer's delivery a precondition of the phase reset, not a side effect.
`hpipe answer` writes `decisions[d].answer` and sets a `pending_answer: <id>` marker but leaves the
task in `blocked-on-decision`; the supervisor returns it to `decision_from` only after `agent prompt`
reports a successful submission. On `PROMPT_RETRY_MAX` exhaustion the task stays blocked and
`hpipe status` says "answered but undelivered", which is a true statement a human can act on.

---

## MAJOR 6 — The review prompts say "dispatch a subagent" and never say "wait for it". A backgrounded subagent ends the worker's turn, and herdr's own detection manifest shows that is a distinct, specially-handled state.

**Location:** §Prompts (spec:216-218): "The four worker `*-review*.md` prompts are delivered **to the
worker** and instruct it to dispatch a Claude Code subagent with a fresh context, handing it the
reviewer brief verbatim and the output path."

**Claim (implied):** That the worker's pane reads `working` for the whole duration of the review, so
"worker idle **and** verdict fresh" is a sound completion predicate for the four review rows.

**Why it's wrong:** The instruction only specifies *dispatch*. Claude Code's Agent tool can run a
subagent in the background, in which case the parent's turn ends and the pane goes to rest while the
review is still being written. This is not speculation about herdr — herdr's own claude detection
manifest (`manifest_version 2026.09.11.1`, read live via `herdr agent explain --json`) carries a
dedicated rule for it:

```
965 background_agents_working working
    line_regex: ^\s*[*·✢✶✻✽]\s+Waiting for [1-9]\d* background agents? to finish\s*$
```

A rule exists because the ordinary working signals do **not** cover a backgrounded subagent — and
that rule only matches while the parent is explicitly *waiting*, not while it has returned to the
prompt. The idle rule that wins otherwise is `live_prompt_box` at priority 950; the only thing that
outranks it is `osc_title_working` at 1100, which needs the parent's own spinner in the terminal
title.

Two further facts sharpen this. First, on this machine the Claude integration is **v7 and outdated
(v7 < v9)**, and reading `~/.claude/hooks/herdr-agent-state.sh` shows v7 reports only
`pane.report_agent_session` on `SessionStart` and `exit 0`s on everything else — it reports no state
at all. `settings.json` wires it to `SessionStart` only. So agent status here is **entirely
screen-scraped**, with no hook backstop. Second, that same v7 hook contains this comment:

> `SubagentStop` is a completion event. Older Herdr integrations mapped it to durable working, but
> Claude recap/away-summary can emit it after the main turn has already stopped. Never let it revive
> an idle pane.

herdr has already been burned by subagent lifecycle events desynchronising pane state. v5 puts a
subagent inside four of its fifteen rows and does not mention it.

**What breaks:** The worker reads idle while the review is unwritten. That alone does not advance the
phase (the verdict file is absent), but it does start the `TASK_STALL_MINUTES` clock against a
perfectly healthy worker, and it removes the actor-idle gate's meaning for those rows — the design's
one guard against "advanced on a file the agent is still writing" degrades to the `FILE_SETTLE_MS`
re-read and the trailer-last-line rule alone.

**Smallest fix:** One sentence in the four review prompts and one in §Prompts: the subagent must be
awaited within the same turn, and **the worker must not end its turn until the verdict file exists at
the named path with a `VERDICT:` trailer**. Add it to `table.test.ts`'s class check as a grep over
`prompts/*-review*.md`.

---

## MAJOR 7 — `intake` and `dispatch` are pure level predicates, so `hpipe rewind` — the design's universal escape — is a no-op on them. This is round 3's `merge`/`close` finding, on the two rows v5 introduces or keeps.

**Location:** Run table (spec:102-103): `intake` — "actor idle **and** ≥1 task registered";
`dispatch` — "≥1 worktree adopted".

**Claim:** Inherited from v4 §Recovery, that `hpipe rewind <run> <phase>` is the escape for a run
advanced early, at any row.

**Why it's wrong:** Neither predicate compares anything to `phase_entered_at`. "≥1 task registered"
and "≥1 worktree adopted" are both monotone: once true, true forever. Rewinding a run to `intake`
re-advances it to `dispatch` on the next tick, and `dispatch` re-advances to `execute` on the tick
after — without the orchestrator having been given a chance to do anything, because the
`intake.md`/`dispatch.md` prompt it was rewound to receive is still in flight.

Round 3 MAJOR 5 caught exactly this for `merge` and `close` ("pure level predicates … so `hpipe
rewind` could not have rescued the two rows it was offered as the escape for") and v4 fixed those two
instances with `mergedAt`/`closedAt` comparisons. v5 adds a new row with the same shape and keeps
another, and the §Phase machine section does not flag either as level-only — where v4's table at
least said out loud that `dispatch`, `merge` and `close` "complete on external state instead".

**What breaks:** The recovery story is false for the two rows a human is most likely to rewind: the
run advanced to `execute` before the orchestrator finished filing tasks (BLOCKER 3's benign path is
"just rewind to `intake`" — and it does not work).

**Smallest fix:** Give both an edge. `intake`: `run.tasks.some(t => t.registered_at >
run.phase_entered_at)`. `dispatch`: `run.tasks.some(t => t.workspace_id !== null &&
t.adopted_at > run.phase_entered_at)`. Both need one new timestamp field each. Alternatively state
plainly, as v4 did, that these rows are level-only and that `hpipe rewind` does not rescue them — but
then BLOCKER 3 has no manual escape either.

---

## MAJOR 8 — The spec never says when a verdict artifact is committed. One of the two possible orderings is a deterministic false advance through `implement`.

**Location:** §Artifacts, "Artifacts are committed on the branch and land in the PR" (spec:255);
§Failure modes row 1, "the verdict files landing in the PR are the backstop" (spec:365); Task table
`implement` row (spec:135) and "**`head_sha_at_entry` is re-captured on every entry to `implement`**"
(spec:156-159).

**Claim:** That re-capturing `head_sha_at_entry` on every `implement` entry closes the livelock
("which is exactly v2's run-level livelock re-created per task").

**Why it's wrong:** It closes the stale-SHA hole and opens a fresh-SHA one, because v5 also moves the
verdict files into the worker's own branch. The spec requires verdicts to land in the PR but never
says who commits them or when. There are only two orderings and it picks neither:

- **Committed during the review phase** (by the review subagent or the worker before its turn ends):
  fine — `head_sha_at_entry` is captured afterwards and the artifact commit is already behind it.
- **Committed at the start of the next `implement` turn** (the natural reading — the reviewer wrote a
  file, the worker picks up the turn and commits the working tree before starting work): the very
  first `git push` moves `headRefOid` off `head_sha_at_entry` with **zero** remediation performed.
  The predicate "worker idle **and** PR exists **and** `headRefOid != head_sha_at_entry`" is satisfied
  on the next tick — or on the tick after the worker's first natural pause — and the still-unfixed PR
  advances to `pr-review-quality`.

This cannot happen in v4: the reviewer is the orchestrator, working in the *main checkout*, writing
the verdict to a path that is never on the worker's branch. Relocating artifacts into the worktree
(§Artifacts, "They resolve against the task's worktree, not `repo_root`") is what creates the false
edge, and that paragraph and the `head_sha_at_entry` paragraph never meet.

**What breaks:** Every BLOCKER verdict on a PR is potentially discharged by a no-op commit. Combined
with BLOCKER 1 (review phases can never escalate), the two PR review gates become advisory.

**Smallest fix:** Order it explicitly. State in §Artifacts that **the review phase's own turn commits
and pushes its verdict**, so the phase does not complete until the verdict is both written and on the
branch — and that `head_sha_at_entry` is therefore captured on `implement` entry *after* that push.
Add the commit-and-push instruction to the four review prompts, next to MAJOR 6's await instruction.

---

# MINORS

## MINOR 1 — `MAX_PASSES = 3` is not the default, and the worked example does not work at 3 either.

**Location:** §Phase machine (spec:151): "arrives at `plan-review` already holding `pass = 2` and
escalates on its first BLOCKER at `MAX_PASSES = 3`."

`src/lib/config.ts` sets `MAX_PASSES: 2`, matching v4's configuration table. And at 3 the sentence is
arithmetically false on its own terms: the implementation tests `pass >= maxPasses`, so a task
arriving with `pass = 2` does *not* escalate on its first BLOCKER at 3 — it returns and increments to
3, escalating on the second. The example is the sole motivation given for a load-bearing rule
(BLOCKER 1); it should use the real default and a trace that holds. **Fix:** `MAX_PASSES = 2`, and
"escalates on its first BLOCKER".

## MINOR 2 — `table.test.ts`'s stated invariants are false for the spec's own table.

**Location:** §Testing (spec:392-394): "every non-terminal row has an `onClear`; … every `actor`
resolves to a pane field that exists on the record type."

By the Task table: `blocked-on-decision` and `escalated` are both non-terminal and both have no
`onClear` — their exits are the dynamic `decision_from` / `escalated_from`. By the `actor` union in
`PhaseRow`, `human` and `supervisor` resolve to no pane field at all (six rows). The one test the
spec offers as the class-level guard against "the v4 review rounds caught four separate instances of
this class one at a time" would fail on the table it is written against. **Fix:** "every non-terminal
row has an `onClear` **or** a dynamic-return field"; "every `actor ∈ {orchestrator, worker}` resolves
to a pane field".

## MINOR 3 — "v4 said 'last task torn down', which never fires on a run with one failed task" is true of v4's prose and false of v4's code.

**Location:** §Phase machine (spec:106).

`src/supervisor/teardown.ts` already advances the run when `run.tasks.every(t => SETTLED.has(t.phase))`,
with `SETTLED = {done, failed, orphaned, blocked-on-failure, escalated}` — v5's terminal set exactly.
The only genuine change in that row is `→ escalated` when no task is `done`. Presenting a shipped
behaviour as a fix is the same defect class the review history keeps flagging in the other direction.
**Fix:** attribute the claim to the v4 *document* and note the implementation already does this.

## MINOR 4 — `--text` is removed but `{{task_text}}` is not, and `render()` throws on an unresolved placeholder.

**Location:** §Roles, "**`hpipe task` stops taking `--text`**" (spec:90); §Prompts, "`worker-brief.md`
inherits from `task.md`: … It **adds** the loop protocol, …" (spec:220-223).

`prompts/task.md` contains `{{task_text}}`, `renderWorkerPrompt` supplies it from `task.text`, and
`render()` throws `unresolved template placeholder` on any `{{…}}` with no value. §Prompts describes
`worker-brief.md` only in terms of what it inherits and adds, never what it drops. An implementer
following it literally ships a template that throws on first dispatch. `Task.text` should also be
stated as removed (replaced by `--notes`). **Fix:** one clause — "and drops `{{task_text}}`; the brief
points at `gh issue view #<n>` instead, plus `{{notes}}`".

## MINOR 5 — The migration message tells the user to do something that is not possible.

**Location:** §Migration (spec:339-341): *"run <id> was started by an earlier plugin version — finish
it on that version or `hpipe abort` it."*

There is one linked plugin per user and one `$HERDR_PLUGIN_STATE_DIR`; "finish it on that version"
would require running two plugin versions against the same state at once. The rest of the section is
sound — `Run` has no version field today (`src/lib/types.ts`), nothing reads a version, and
`listRuns` casts blindly, so adding `schema_version` and filtering unversioned runs out of the
supervisor loop is a handful of lines and genuinely achievable where the spec says it is. Note also
that `activeRunForRepo` treats any non-`done` run as active, so a stranded v4 run blocks `hpipe
start` until aborted — worth saying. **Fix:** *"run <id> was started by an earlier plugin version and
cannot be advanced — `hpipe abort <id>` to release the repo."*

---

# Verification

## Claims about the implementation — all checked against `feat/plugin-implementation`

| Spec claim | Verdict | Evidence |
| --- | --- | --- |
| `nextDelivery` hardcodes the orchestrator pane | **TRUE** | `src/supervisor/deliver.ts`: `if (!input.run.orchestrator_pane) continue; return { paneId: input.run.orchestrator_pane, … }`. It also returns at most **one** delivery for the whole tick — see BLOCKER 4. |
| `artifactPathFor` assumes every task artifact is a verdict | **TRUE** | `src/supervisor/deliver.ts`: `if (task) { const key = \`${task.task_id}-${task.phase}-${task.pass}\`; return run.artifacts.verdicts[key] ?? join('docs/superpowers/reviews', …) }` — no other branch. |
| `gating.ts` owns a phase set `machine.ts` doesn't know about | **TRUE** | `HOLDS_FILES` is a module-private `ReadonlySet<TaskPhase>` in `src/lib/gating.ts`; `machine.ts` imports nothing from `gating.ts`. |
| `worktree.created` carries a checkout path the implementation discards | **TRUE, and better-founded than stated** | Verified in herdr 0.9.0's own bundled schema (`herdr api schema --json`): `worktree_created` carries `worktree: WorktreeInfo` with **required** `path`, and `workspace: WorkspaceInfo` whose `worktree` is `WorkspaceWorktreeInfo` with **required** `checkout_path`. `src/hooks/_hook.ts` already reads `raw.worktree.path` into `QueuedEvent.checkout_path`; `src/supervisor/tick.ts`'s `worktree.created` branch sets only `workspace_id` and drops it. The fix is ~2 lines, not a new event. |
| `TaskSignals` has both `actorIdle` and `workerIdle` | **TRUE** | `src/lib/machine.ts`, `interface TaskSignals`. `gatherSignals` populates `actorIdle` from `deps.actorIdle` and `workerIdle` from `isAgentReady(task.agent_status)`. |
| v4's `advanceRun` carries one `pass` across review phases | **TRUE** | `run.pass` is a single scalar; `advanceRun` increments it on BLOCKER and **never resets it on CLEAR**, across `spec-review`, `plan-review`, `branch-review`. The spec's diagnosis is right; its cure is BLOCKER 1. |
| "v4 said 'last task torn down', which never fires on a run with one failed task" | **FALSE of the code** | `src/supervisor/teardown.ts` already uses `every(SETTLED)` with v5's exact terminal set. True of the v4 document only. See MINOR 3. |
| `MAX_PASSES = 3` | **FALSE** | `src/lib/config.ts`: `MAX_PASSES: 2`. See MINOR 1. |
| `hpipe rewind` "unchanged semantics" | **FALSE under v5** | `cmdRewind` sets `pass = 1`; v5's base is 0. See BLOCKER 1. |

## Claims about herdr 0.9.0 and `gh`

**Verified.**

- `herdr --version` → `herdr 0.9.0`. `gh` is 2.x at `/opt/homebrew/bin/gh`.
- **Worker panes are prompted exactly like orchestrator panes.** `herdr agent prompt --help`:
  `Usage: herdr agent prompt <TARGET> <TEXT>`, where TARGET is a pane id or a live agent name. No
  distinction of any kind between panes in linked worktrees and panes in a main checkout. The
  `agent_blocked`-before-input guarantee v4 relies on is restated in that help text verbatim.
- **`agent_status` for a worker in a linked worktree has the same shape.** `herdr agent list` on the
  live session returns a pane whose `cwd` is `/Volumes/stein/.cache/ticket-review/worktrees/…`
  reporting `"agent_status":"idle","interactive_ready":true` — the same fields, same values as the
  non-worktree panes in the same listing. Detection is per-pane screen state and does not read `cwd`.
- **`gh` field names.** `gh pr view --json` exposes `closed`, `headRefOid`, `mergedAt`, `state`, and
  **no `merged`**. `gh issue view --json` exposes `closed`, `closedAt`, `state`. v4's table is
  correct and v5 inherits it correctly. The field names are not the problem in BLOCKER 2; the
  comparison is.
- **`worktree_created` payload** — see the table above; read out of `herdr api schema --json`, which
  is the bundled schema for the running binary.
- **Agent status on this machine is screen-scraped, with no hook backstop.**
  `herdr integration status` → `claude: outdated (v7 < v9)`. Reading
  `~/.claude/hooks/herdr-agent-state.sh` (v7): it `exit 0`s unless invoked with `session`, and its
  only socket call is `pane.report_agent_session`. It reports **no state**. `~/.claude/settings.json`
  wires it to `SessionStart` only. So every `agent_status` this plugin reads comes from the screen
  scrape.
- **The detection rules and their priorities**, from `herdr agent explain <pane> --json`
  (manifest `remote:…/agent-detection/remote/claude.toml`, version `2026.09.11.1`):
  `osc_title_working` 1100 → working; `btw_overlay_working` 975; `live_turn_working` 970;
  `background_agents_working` 965 → working, matching `^\s*[*·✢✶✻✽]\s+Waiting for [1-9]\d* background
  agents? to finish\s*$`; `background_mcp_task_working` 965; `live_prompt_box` 950 → idle (the rule
  that matched); `osc_title_idle` 250. A backgrounded subagent is a **separately-ruled** state, not
  the ordinary working state — the basis for MAJOR 6.

**Could not verify.**

- **Whether a Claude Code subagent dispatched inside a worker's pane keeps that pane at `working`
  for the review's whole duration.** This needs a live pane running a subagent and a concurrent
  `herdr agent get`, which I could not stage without starting an agent in the user's session. What I
  can say with evidence: if the subagent is awaited in-turn the parent's OSC-title spinner keeps
  `osc_title_working` (priority 1100) above `live_prompt_box` (950), so the pane should read
  `working`; if it is backgrounded, the pane's state depends on a rule that matches only the literal
  "Waiting for N background agents to finish" line. The design must not be built on the assumption
  without pinning the prompt to the awaited form (MAJOR 6). **This is the one claim the caller
  flagged as critical, and it remains open.**
- **Whether `closedAt` can, in some GitHub timings, land after the supervisor's `close` phase entry.**
  Auto-close is a merge side effect and the merge is polled every tick, so the window is ~1-2s and
  the race is at best non-deterministic — but I did not merge a live PR to measure it. BLOCKER 2 does
  not depend on the measurement: a predicate that is satisfiable only by a sub-second race is broken
  either way, and this repo's project memory already records it failing in practice.
- **Whether `herdr agent prompt` to a worker pane in a *linked worktree workspace* is subject to any
  workspace-group restriction.** Nothing in `agent prompt --help`, the skill, or the schema suggests
  one, and pane ids are workspace-qualified uniformly — but I did not send a prompt to a live worker
  pane.

## Things I checked and found sound

- `RunArtifacts` shrinking to `{ verdicts }` is coherent: the only surviving run-level artifact phase
  is `branch-review`.
- `execute` → `escalated` when no task is `done` is a genuine improvement over the implementation's
  unconditional `branch-review`.
- Keeping `research` as its own artifact is well-argued and the stated reason (the unverified-claims
  failure class) is the correct one — this review is itself the worked example.
- `blocked-on-decision` holding its `files` reservation is right, for the reason given.
- `pass` not incrementing on a decision is right.
- The `pr-review-*` rename over `task-review-*` is right, and for the stated reason.
- The `schema_version: 2` "refuse to advance" is achievable where the spec says it is (MINOR 5
  concerns only the user-facing string).

VERDICT: BLOCKER
BLOCKERS: 5
MAJORS: 8
