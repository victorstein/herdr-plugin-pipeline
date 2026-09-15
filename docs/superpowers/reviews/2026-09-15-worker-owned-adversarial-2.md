# Worker-owned pipeline (v5) — adversarial review 2

**Target:** `docs/superpowers/specs/2026-09-15-worker-owned-pipeline-design.md` (v2, commit `3593b25`)
**Audited against:** round 1 (`reviews/2026-09-15-worker-owned-adversarial-1.md`),
`specs/2026-09-13-herdr-pipeline-plugin-design.md` (v4), and the implementation on
`feat/plugin-implementation`.
**Date:** 2026-09-15

## Summary

v2 is a real revision, not a wording pass. Eleven of round 1's eighteen findings are genuinely
closed, none are purely cosmetic, and the document's new material — the per-phase `passes` map, the
`intake_closed` flag, the `blocked-on-files` row, the delivery-as-precondition on `hpipe answer`, the
per-pane `Delivery[]` — is better reasoned than what it replaces. The two false claims round 1 made
about the v4 implementation (`MAX_PASSES = 3`, "last task torn down") are corrected and correctly
attributed, and v2's own new claims about `nextDelivery`, `applyEvents`, `cmdRewind`, `listRuns`,
`activeRunForRepo`, `render()` and `worktree.created` all check out against source.

Seven fixes are **displaced** rather than genuine, and the pattern is the one v2's own review-history
note names: the class is one level up from where the fix landed.

The headline is round 1's BLOCKER 1 again. The per-phase `passes` map does bound
`spec ↔ spec-review`, `plan ↔ plan-review` and the `implement ↔ pr-review-*` sub-loop — I traced all
four. But it deletes a bound that is already shipped. `advanceTask`'s `ci` case tests
`task.pass >= s.maxPasses` and escalates, with a comment naming the exact hazard; `Task.pass` is
removed, and v2's `ci` row carries no counter at all. Because both PR review rows *delete* their own
counters on `CLEAR`, the loop `implement → pr-review-intent → pr-review-quality → ci(red) → implement`
resets every counter it touches on each lap and runs forever. That is round 3's MAJOR 4, restored by
the fix written to prevent it — the identical move v1 was blocked for.

Beside it: `execute` can now hang forever instead of completing early, and the mitigation v2 states
for that hang does not exist in the code it claims to inherit. `blocked-on-files` — a new phase added
for throughput — starves permanently behind a `failed` sibling and has an actor that resolves to no
pane, so nothing probes it. The `hpipe answer` delivery precondition rests on a `PROMPT_RETRY_MAX`
retry loop that `main.ts` does not implement, and its "answered but undelivered" state has no exit.
`hpipe rewind <run> dispatch` is now a dead end, because `adopted_at` can only ever be written once.
And the fix for round 1's MAJOR 8 depends on an idle signal whose source v2 never names — the two
readings have opposite defects.

Counts: 11 genuine / 0 cosmetic / 7 displaced; 2 BLOCKER, 5 MAJOR, 6 MINOR new findings.

---

# Audit of round 1's fixes

| # | Round 1 finding | Class | One-line reason |
| --- | --- | --- | --- |
| B1 | Per-phase `pass` makes `MAX_PASSES` unreachable | **displaced** | Bounds the three review loops; deletes the shipped `ci` bound, so the `ci → implement` loop is now unbounded. → **BLOCKER 1** |
| B2 | `close` predicate unsatisfiable under `Closes #n` | **genuine** | `closed && closedAt >= merged_at_ms`, `merged_at_ms` recorded at `merge`. Satisfiable on the auto-close path. Two gaps → MINOR 5, MINOR 6 |
| B3 | `execute` completes on a level predicate over a growing set | **displaced** | `intake_closed` stops the early close and creates a permanent hang whose only stated mitigation is verifiably absent. → **BLOCKER 2** |
| B4 | Delivery addresses one pane per tick | **genuine** | `Delivery[]` grouped by pane, header only on the orchestrator, coalescing restated per actor pane, `resumePrompt`/`resumeActor` added |
| B5 | Second `hpipe decide` overwrites `decision_from` | **genuine** | Refused when already blocked; never writes `decision_from` from `blocked-on-decision`; at-most-one-open-decision stated |
| M1 | `files` reservation spans eight phases | **displaced** | Split gate is right; `blocked-on-files` starves behind `failed`/`escalated` with no probe and no escape. → **MAJOR 1** |
| M2 | Stall probe targets a null pane | **genuine** | Made a property of the probe, not a per-row exception. Does not cover `supervisor`-actor rows — folded into MAJOR 1 |
| M3 | "Only writers of `blocked-on-decision`" is false | **genuine** | Reworded to "only predicate-driven"; abandon-on-pane-death added; `hpipe answer` refuses a non-blocked task |
| M4 | `src/actions/` placement | **genuine** | `src/cli.ts` explicitly, with the `plugin.action.invoke` reason restated |
| M5 | "Wasteful, not incorrect" is incorrect | **displaced** | Right shape, wrong substrate: the retry loop it depends on does not exist, and the new terminal state has no exit. → **MAJOR 2** |
| M6 | Review prompts never say "wait for it" | **genuine** | Await + verdict-file precondition added to all four, residual explicitly priced and assigned to the live run. Test glob is wrong → MINOR 4 |
| M7 | `intake`/`dispatch` are level predicates | **displaced** | Edges added; `adopted_at` is write-once, so `rewind → dispatch` now has no satisfiable exit. → **MAJOR 3** |
| M8 | Spec never says when a verdict is committed | **displaced** | Ordering fixed; the predicate it protects depends on an idle source v2 never names. → **MAJOR 4** |
| m1 | `MAX_PASSES = 3` is not the default | **genuine** | "MAX_PASSES = 2 (the configured default)… escalates on its first BLOCKER". Matches `src/lib/config.ts` |
| m2 | `table.test.ts` invariants false for the table | **genuine** | "`onClear` **or** a `returnsTo`", "`actor ∈ {orchestrator, worker}`". Both hold against v2's table. New instances → MINOR 4, MINOR 3 |
| m3 | "last task torn down" is false of v4's code | **genuine** | Attributed to the v4 *document*, with the `every(SETTLED)` code named |
| m4 | `{{task_text}}` survives `--text` removal | **displaced** | `{{task_text}}` fixed; `{{pass}}` in two "kept" prompts is the same defect, created by the same section. → MINOR 2 |
| m5 | Migration message is impossible | **genuine** | Message corrected verbatim; `activeRunForRepo` note added and verified |

**11 genuine / 0 cosmetic / 7 displaced.**

Detail on every non-genuine fix follows in the findings below: B1 → BLOCKER 1, B3 → BLOCKER 2,
M1 → MAJOR 1, M5 → MAJOR 2, M7 → MAJOR 3, M8 → MAJOR 4, m4 → MINOR 2.

## The traces the caller asked for

**Does `MAX_PASSES` bound all four worker review loops?** Three of four, and the fourth only if you
never look through `ci`. Under spec:161-163 ("a review row's `onBlocker` increments
`passes[reviewPhase]` and tests **that** value…; a review row's `onClear` deletes
`passes[reviewPhase]`"):

| loop | bounded? | why |
| --- | --- | --- |
| `spec ↔ spec-review` | **yes** | `spec` is not a review row, so nothing deletes `passes[spec-review]` between laps |
| `plan ↔ plan-review` | **yes** | same |
| `implement ↔ pr-review-intent` | **yes** | same |
| `implement ↔ pr-review-quality` | **yes, loosely** | each lap re-enters `pr-review-intent`, whose `CLEAR` deletes only its own key. Note the total implement-turn budget is ~`MAX_PASSES²`, not `MAX_PASSES` |
| `implement → …→ ci(red) → implement` | **no** | `ci` increments nothing, and both review rows delete their own counters on the `CLEAR` each lap |

**`hpipe rewind`:** clears the whole map (spec:163, spec:177-179). For tasks that is sound and fixes
`cmdRewind`'s `pass = 1`. For runs it is a dead end on two rows — see MAJOR 3.

**`ci` → `implement` re-entry:** `head_sha_at_entry` is re-captured (spec:210), so no false advance.
But the verdict keys reset to `-0` (see MINOR 3) and no counter moves (BLOCKER 1).

**Verdict key rendering:** `<phase>-<passes[phase] ?? 0>` is correct within one uninterrupted review
loop and wrong across a `pr-review-quality` BLOCKER or a CI-red lap — MINOR 3.

---

# BLOCKERS

## BLOCKER 1 — The per-phase `passes` map deletes the CI retry bound that ships today. `implement → pr-review-intent → pr-review-quality → ci → implement` has no bound at all.

**Location:** Task table `ci` row (spec:143); `pr-review-intent` / `pr-review-quality` rows
(spec:141-142); §`passes` is keyed by phase (spec:159-163); §Configuration (spec:509-511).
This is round 1's BLOCKER 1, **displaced**.

**Claim:** "`MAX_PASSES` (default **2**) covers all four worker review phases under the per-phase
counter" (spec:510-511), and the review-history note: "The counter is now keyed by the phase it
bounds" (spec:24).

**Why it's wrong:** `Task.pass` is not only the review counter. It is also the **CI** counter, and
the implementation says so explicitly (`src/lib/machine.ts`, `advanceTask`, case `'ci'`):

```ts
if (s.ciBucket === 'fail') {
  // CI retries draw on the same budget as review retries. Without this the
  // task cycles execute → review → ci → execute forever, bypassing the one
  // safety valve the module has.
  if (task.pass >= s.maxPasses) {
    return enterTaskPhase(run, task, 'escalated', `CI still red after ${task.pass} passes`)
  }
  enterTaskPhase(run, task, 'execute', 'CI red')
  task.pass += 1
  …
```

v2 replaces `Task.pass` with `passes: Partial<Record<Phase, number>>` and attaches increments only to
review rows. The `ci` row (spec:143) reads in full:

> `| ci | supervisor | gh pr checks bucket terminal and changed | pass → merge | fail → implement with the failing check |`

No counter, no `MAX_PASSES` branch, no `escalated`. And the loop through `ci` is self-cleaning,
because v2's own rule deletes counters on `CLEAR`:

| step | phase | `passes` after |
| --- | --- | --- |
| 1 | `implement` (CI-red re-entry) | `{}` |
| 2 | `pr-review-intent` CLEAR | deletes `passes[pr-review-intent]` → `{}` |
| 3 | `pr-review-quality` CLEAR | deletes `passes[pr-review-quality]` → `{}` |
| 4 | `ci` red → `implement` | **no key touched** → `{}` |
| 5 | back to step 1, forever | |

The `head_sha_at_entry` re-capture (spec:208-210) guarantees each lap makes a *real* commit, so this
is not a tight spin — it is an agent burning turns indefinitely on a check it cannot make green
(a flaky required check, a missing secret, a `main`-only workflow). Nothing escalates it, because
`escalated` is what the digest reports and what `hpipe status` flags.

Worse, `table.test.ts` cannot catch it: its stated class check is "every `verdict` row has an
`onBlocker`" (spec:559), and `ci`'s `signal` is `'ci'`, not `'verdict'`. The one guard v2 offers
against this exact class is scoped to exclude the row that has the defect.

**What breaks:** A task with a permanently red check never terminates. It holds its `files` from
`implement` onward (spec:199-200), so every overlapping sibling starves in `blocked-on-files`
(MAJOR 1), and `execute` never sees "every task terminal" (spec:94), so the run never reaches
`branch-review`. This is round 3's MAJOR 4 and round 1's BLOCKER 1, restored by the fix for round 1's
BLOCKER 1.

**Smallest fix:** Give `ci` a key of its own. `ci`'s `fail` branch increments `passes[ci]` and tests
it against `MAX_PASSES`, escalating at the bound; `ci`'s `pass` branch (`→ merge`) deletes
`passes[ci]`. State the general rule as "**every** row that can return a task to a producer phase
carries a counter keyed by itself", and widen `table.test.ts` from "every `verdict` row has an
`onBlocker`" to "every row with an `onBlocker` names a counter key and a `MAX_PASSES` branch."

---

## BLOCKER 2 — `intake_closed` converts BLOCKER 3's early completion into a permanent hang, and the mitigation v2 states for that hang does not exist.

**Location:** Run table `execute` row (spec:94); spec:117-119; §Failure modes last row (spec:541).
This is round 1's BLOCKER 3, **displaced**.

**Claim:** spec:541 — "The orchestrator forgets `hpipe dispatch --done` | The run sits in `execute`
with every task terminal. **The stall probe covers it**, and `hpipe status` names the missing close."

**Why it's wrong — two independent reasons.**

*First, the stall probe does not cover `execute`.* `stallCandidates` (`src/supervisor/stall.ts`)
opens with `if (!ARTIFACT_RUN_PHASES.has(run.phase)) continue`, and `ARTIFACT_RUN_PHASES`
(`src/lib/machine.ts`) is `{spec, spec-review, plan, plan-review, branch-review}` — `execute` is not
in it and never was. `taskStallCandidates` gates on `task.phase !== 'execute'`, which is the *task*
phase, and every task in this scenario is terminal. v2 never marks the run `execute` row
`stallable` — the Run table has no such column, §Code shape says "`stallable` is explicit, not
derived from `signal`" (spec:471), and `execute`'s `actor` is `—` (null), so there is no row actor to
resolve a probe to and no fallback rule that applies (the fallback at spec:345-348 is written for a
*null pane*, not a *null actor*). The mitigation is asserted, not designed.

*Second, the orchestrator is never told to re-close.* `intake_closed` is "**cleared by any subsequent
`hpipe task`**" (spec:117-118), and `hpipe task` is accepted in `execute` (spec:499). The instruction
to call `hpipe dispatch --done` lives in exactly one place — `dispatch.md` (spec:392, "revised …
adds `hpipe dispatch --done`") — which is delivered only on entry to the run `dispatch` phase. A run
in `execute` never re-enters `dispatch`. So the ordinary sequence the design exists to support:

1. `intake` → `dispatch` → `execute`, orchestrator calls `hpipe dispatch --done` from `dispatch.md`.
2. The human reports a second problem. Orchestrator runs `hpipe task` → `intake_closed = false`.
3. t2 runs to `done`. Every task is terminal.
4. `intake_closed` is `false`. `execute` never completes. Nothing prompts anyone about it. The only
   prompt the orchestrator will ever receive again is the `queued`-gate dispatch prompt, which says
   nothing about closing intake.

The run hangs. `hpipe status` "names the missing close" only if someone runs it, and nothing prompts
that either.

**What breaks:** The one capability §Problem is written to deliver ("you report a problem mid-run")
now hangs the run instead of shipping a third of it. The failure is quieter than v1's: v1 shipped
early and visibly; v2 sits in `execute` looking healthy.

**Smallest fix:** Two clauses. (a) The `queued`-gate dispatch prompt — the one delivered to the
orchestrator when a task's gate opens — carries the `hpipe dispatch --done` instruction too, so any
path that registers a task also carries the path that closes intake. (b) Mark the run `execute` row
`stallable: true` with the probe targeting `run.orchestrator_pane` directly (it has no row actor),
and say so in the table, so `STALL_MINUTES` genuinely covers `intake_closed === false && every task
terminal`. Delete "the stall probe covers it" until (b) is written.

---

# MAJORS

## MAJOR 1 — `blocked-on-files` starves permanently behind a `failed` or `escalated` sibling, has an actor that resolves to no pane, and is not terminal. The run hangs with no escape.

**Location:** Task table `blocked-on-files` row (spec:139); `holdsFiles` rules (spec:198-203);
stall fallback (spec:345-348); §Testing `gating.test.ts` (spec:551-553).
This is round 1's MAJOR 1, **displaced**.

**Claim:** spec:199-200 — "`holdsFiles` is true from `implement` onward, **plus `failed` and
`escalated` (which leave unmerged work and are never torn down)**"; spec:205-206 — "Ties are broken
by `task_id` ordering so two mutually-overlapping tasks cannot both wait on each other."

**Why it's wrong:** The split gate is the right call and I am not arguing against it. But moving the
wait into a *named, non-terminal, supervisor-actor* row creates three problems v1's `queued` gate did
not have in the same shape.

1. **Permanent starvation with no exit.** t1 and t2 declare overlapping `files`. t1 reaches
   `implement` and its pane dies. `applyEvents` (`src/supervisor/tick.ts`) writes `failed` from any
   phase with no guard — v2 relies on exactly this at spec:283-287. `failed` holds files forever by
   v2's own rule, and nothing ever tears a failed task down. t2 sits in `blocked-on-files` for the
   life of the run. `blocked-on-files` is **not** in the terminal set (spec:121-122), so `execute`
   never completes and the run never reaches `branch-review`. The only tool that moves a task is
   `hpipe rewind --task`, and the human would have to know to rewind the *dead* task to a phase that
   does not hold files — a move the document never mentions and `hpipe status` gives no hint of.
2. **Nothing probes it.** The row's `actor` is `supervisor`. v2's probe fallback (spec:345-348) is
   written for "a probe whose row actor resolves to a **null pane**" — a `worker` row with
   `pane_id === null`. `supervisor` resolves to no pane field at all, and `table.test.ts`'s pane
   invariant is explicitly scoped to "`actor ∈ {orchestrator, worker}`" (spec:560-561). So the one
   state where a task can wait indefinitely is the one state with no stall coverage.
3. **The stated tie-break addresses a deadlock that cannot occur and misses the race that can.**
   Because `blocked-on-files` is `holdsFiles: false` (spec:201), two mutually-overlapping tasks in
   that row cannot block each other — neither is "in flight". The deadlock the `task_id` tie-break is
   offered against is impossible by construction. What *can* happen is the opposite: at one
   evaluation both read "no in-flight task holds an overlapping prefix" and both are eligible to
   enter `implement`. Today only the sequential order of `advanceTasks`' `for (const task of
   run.tasks)` loop separates them, and v2 never states that the evaluation is sequential or that
   ordering is load-bearing. `gating.test.ts`'s stated assertion — "two mutually-overlapping tasks do
   not deadlock" (spec:553) — tests the impossible case and not the real one.

**What breaks:** One dead worker permanently wedges every task that declared an overlapping prefix,
and permanently wedges the run. Since `--files` is a declared-intent *prefix* heuristic and v2 itself
says "two tasks both declaring `packages/core/src/` is the normal case" (spec:191-192), the blast
radius of one pane death is the whole fleet.

**Smallest fix:** (a) `teardown`'s "unblocks `queued` and `blocked-on-files`" is not enough — say
that entering `failed` or `escalated` **also** re-evaluates `blocked-on-files`, and give the human
one documented release: `hpipe forget`-style "release t1's files" or a stated `hpipe rewind --task t1
blocked-on-failure`. (b) Mark `blocked-on-files` `stallable: true` with the probe targeting
`run.orchestrator_pane` (there is no supervisor pane), and widen the fallback rule from "null pane"
to "no pane". (c) Replace the tie-break sentence with the real invariant: overlap is resolved in one
pass over tasks in `task_id` order, at most one task leaves `blocked-on-files` per overlapping group
per tick. Make *that* the `gating.test.ts` assertion.

---

## MAJOR 2 — The `hpipe answer` delivery precondition rests on a `PROMPT_RETRY_MAX` retry loop `main.ts` does not implement, and "answered but undelivered" has no exit.

**Location:** §Resume (spec:310-327); §Failure modes row 5 (spec:536); §Code shape item 1
(spec:478-481). This is round 1's MAJOR 5, **displaced**.

**Claim:** spec:316-318 — "`agent prompt` rejects with `agent_blocked` before sending input, and
**retries are bounded by `PROMPT_RETRY_MAX` (5) at `TICK_MS` (1000)**"; spec:325-327 — "On
`PROMPT_RETRY_MAX` exhaustion the task stays blocked and `hpipe status` reports **'answered but
undelivered'**, which is a true statement a human can act on."

**Why it's wrong — three layers.**

*The retry loop does not exist.* v4's §Event transport says "Delivery retries with backoff across
ticks on `agent_blocked` or a missing pane, up to `PROMPT_RETRY_MAX`, then holds and reports in
`status`" (v4:535-536), and v2 inherits that sentence as an existing-code fact. The code does not do
it. `src/supervisor/main.ts`:

```ts
const delivery = nextDelivery(digests)
if (delivery) {
  const sent = await herdr.agentPrompt(delivery.paneId, delivery.text)
  if (!sent.ok) {
    attempts += 1
    if (!shouldRetry(sent.code, attempts, config.PROMPT_RETRY_MAX)) {
      console.error(`[pipeline] giving up on delivery: ${sent.code}`)
      attempts = 0
    }
  } else { attempts = 0 }
}
```

`delivery.text` is never re-sent. `digests` is rebuilt from scratch each tick out of that tick's wake
lines and that tick's phase advances; a prompt that fails is gone, because `saveRun` already ran
inside the advance loop. `attempts` is a counter of *consecutive failures of different deliveries*,
and it is reset both on success and on give-up. (It is also function-scoped inside `main()`, not
"module-level" as spec:480 says — trivial, but it is one more claim about the code that does not
match it.) So the mechanism v2's fix is built on is a documented intention, not shipped behaviour,
and §Code shape's change list — which is written to be complete — does not include "add a durable
per-task delivery driven off `pending_answer`."

*The exhaustion semantics are unstated and the two readings contradict each other.* v2 replaces the
single counter with "per-pane retry counters" (spec:480) and then hangs a *terminal user-visible
state* off that counter's exhaustion. If per-pane counters reset on give-up, as `attempts` does
today, "answered but undelivered" is never durable — the next tick starts over and the state v2
promises `hpipe status` will show never appears. If they do not reset, one exhausted worker pane is
permanently unreachable for **every** prompt, not just this one, because the counter is keyed by pane
and not by message. Neither reading is stated, and the design depends on the distinction.

*There is no exit.* The caller asked specifically: does "answered but undelivered" have one? No.
- `hpipe decide` is refused (the task is already blocked, spec:274-275).
- `hpipe answer` is accepted (the task *is* in `blocked-on-decision`), but re-answering writes the
  same `pending_answer` and — under the non-resetting reading — does nothing to re-arm a per-**pane**
  counter.
- `hpipe rewind --task <id> <decision_from>` is the only thing left. Nothing in spec:503-506 says
  rewind clears `pending_answer` or re-delivers `answer.md`. So the human's only escape returns the
  task to its producer phase with the answer still unread — **the exact failure the precondition was
  added to prevent**, now reached by following the document's own recovery advice, with
  `run.history` again asserting the decision was applied.

*And a pane death between `hpipe answer` and delivery is unhandled.* spec:283-287 marks "every
**open** decision" abandoned on `pane.exited`. A decision with `answer` set is not open. The task goes
`failed` with `pending_answer` still set, and `hpipe status` keeps reporting "answered but
undelivered" for a dead task — which is round 1's MAJOR 3 residue, displaced from `decisions[]` onto
the new field that was added to fix MAJOR 5.

**What breaks:** Every failure mode MAJOR 5 identified survives, reached by a different route, with a
new user-facing state that either never appears or never clears.

**Smallest fix:** (a) Add "a per-task pending delivery, re-attempted each tick while
`pending_answer` is set" to §Code shape's change list, and say plainly that v4's "retries across
ticks" is a *document* claim the implementation does not honour (the same correction v2 already makes
for "last task torn down"). (b) Make the retry budget per **message**, not per pane, and say it
resets on a successful send to that pane. (c) Give the state an exit: `hpipe answer` on a task that
already has `pending_answer` re-arms delivery and says so; `hpipe rewind --task` clears
`pending_answer` and records "answer discarded undelivered" in `run.history`. (d) Extend the abandon
rule from "every open decision" to "every open **or undelivered** decision".

---

## MAJOR 3 — `adopted_at` is write-once, so `hpipe rewind <run> dispatch` now has no satisfiable exit. The level-predicate fix overshot into a dead end.

**Location:** Run table `dispatch` row (spec:93); spec:102-106.
This is round 1's MAJOR 7, **displaced**.

**Claim:** spec:102-106 — "v1 wrote them as '≥1 task registered' and '≥1 worktree adopted', both
monotone: once true, true forever, so `hpipe rewind` — the design's universal escape — re-advanced
them on the next tick. … `Task` gains `registered_at` and `adopted_at` so both rows compare against
the run's `phase_entered_at`."

**Why it's wrong:** The edge is now correct and the re-advance is fixed. But nothing can ever
re-write `adopted_at` for a task that has already been adopted. `applyEvents`
(`src/supervisor/tick.ts`) handles `worktree.created` with:

```ts
const found = findTask(runs, (t) => t.branch === event.branch && t.workspace_id === null)
if (found) { found.task.workspace_id = event.workspace_id; changed = true }
```

The `t.workspace_id === null` guard means the event matches a task exactly once in its life. Whatever
sets `adopted_at` sits on this branch (or on the `pane.agent_detected` branch, which also only ever
assigns `pane_id`). So after a rewind to `dispatch`, the predicate "a task whose
`adopted_at > phase_entered_at` exists" is unsatisfiable for **every existing task**. The only way
out is to register a brand-new task and adopt a brand-new worktree.

That matters because `dispatch` is the row a human rewinds to for the scenario round 1's BLOCKER 3
described and v2 preserves: the run advanced past dispatch before the orchestrator had finished
standing workers up. Rewinding to `intake` is survivable — the point of rewinding there is to
register more, and `registered_at` will be written by the next `hpipe task`. Rewinding to `dispatch`
is a trap that the document advertises as the escape.

**What breaks:** `hpipe rewind <run> dispatch` wedges the run in `dispatch` permanently. v1's defect
was "rewind is a no-op"; v2's is "rewind is a one-way door". Both make the recovery story false, on
the same row.

**Smallest fix:** One sentence plus one field write. Say that `hpipe rewind <run> dispatch` **clears
`adopted_at` on every task whose `workspace_id` is still bound**, so an already-adopted task
re-qualifies; or, simpler, make the `dispatch` edge "a task whose `adopted_at > phase_entered_at`
exists **or** the rewind that entered this phase cleared `adopted_at`". Either way, say explicitly in
§Recovery what the human is supposed to do after rewinding to `dispatch` with every task already
adopted.

---

## MAJOR 4 — The `head_sha_at_entry` fix depends on a worker-idle signal v2 never names. The two readings have opposite defects and neither is priced.

**Location:** §`head_sha_at_entry` and when verdicts are committed (spec:208-222); §Code shape item 2
(spec:482-484). This is round 1's MAJOR 8, **displaced**.

**Claim:** spec:219-221 — "**The review phase's own turn commits and pushes its verdict.** The phase
does not complete until the verdict is written *and* on the branch, and `head_sha_at_entry` is
captured on `implement` entry afterwards." And spec:483-484 — "`TaskSignals`' separate `actorIdle`
and `workerIdle` collapse into one `actorIdle` resolved per row."

**Why it's wrong:** The ordering is right. What it depends on is not specified. In the implementation
the two signals are not interchangeable and were never meant to be:

- `actorIdle` (the orchestrator) is read **live** and **double-checked**: `evaluateRun`
  (`src/supervisor/deliver.ts`) calls `herdr.agentStatus(pane)`, verifies freshness, then
  `await Bun.sleep(config.ACTOR_SETTLE_MS)` and reads the status a second time. `main.ts` passes that
  already-double-checked boolean in as `deps.actorIdle`.
- `workerIdle` is read from the **cache**: `gatherSignals` (`src/supervisor/tasks.ts`) computes
  `workerIdle: isAgentReady(task.agent_status)`, and `task.agent_status` is only ever written by
  `applyEvents` from a `pane.agent_status_changed` event. No live read, no settle, no second look.

"Collapse into one `actorIdle` resolved per row" does not say which of these survives, and the two
readings break differently:

*Cached reading.* The worker writes the verdict file and then runs `git commit && git push`. Between
those two, the cached `task.agent_status` can still be `idle` from the end of its previous turn — the
`working` event has not landed, or the screen scrape has not flipped. The supervisor sees "worker
idle **and** verdict fresh, parses" (spec:141), advances to `implement`, and captures
`head_sha_at_entry` **before the push**. The worker's own push then satisfies
`headRefOid != head_sha_at_entry` with zero remediation, and the unfixed PR advances to
`pr-review-quality`. That is MAJOR 8's defect exactly, reached through the signal instead of the
ordering — and it is *more* likely under v2 than v4, because v2 is the version that puts the verdict
commit inside the review turn.

*Live reading.* Correct, but `evaluateRun`'s guard costs one `ACTOR_SETTLE_MS` sleep (750ms default)
per pane per evaluation, sequentially inside the tick loop. With three workers advancing, the tick
body spends ≥2.25s sleeping against `TICK_MS = 1000`. v2's whole thesis is "fleet width scales with
worker count" (spec:32); the guard it needs for correctness makes tick duration scale with worker
count too, and §Configuration says "No new keys" (spec:509). That cost is nowhere in §Failure modes
and nowhere in the "accepted and priced" list.

**What breaks:** Under one reading, PR review gates are advisory; under the other, the supervisor's
tick period silently becomes a function of fleet width. The document picks neither.

**Smallest fix:** One sentence in §Code shape item 2: "`actorIdle` is resolved per row as a **live**
`herdr agent status` read on `row.actor`'s pane, double-checked after `ACTOR_SETTLE_MS`, exactly as
`evaluateRun` does today for the orchestrator; `task.agent_status` remains the badge/wake cache and
is never a completion signal." Then add one §Failure modes row pricing the per-pane settle cost, and
say whether the settles run concurrently.

---

## MAJOR 5 — §Prompts and the `queued` row name different recipients for `worker-brief.md`, in the one document whose BLOCKER-4 fix is entirely about routing.

**Location:** §Prompts table row 3 (spec:390): "`worker-brief.md` (replaces `task.md`) | **worker**,
at dispatch". Task table `queued` row (spec:134): "supervisor prompts the **orchestrator** to
dispatch, **carrying the rendered worker brief**". §Code shape item 1 (spec:476-481).

**Claim:** Both, simultaneously.

**Why it's wrong:** They cannot both be true, and the `queued` row is the one that matches reality: a
`queued` task has no pane (v2 says so at spec:224-228 — "`pane_id` arrives from
`pane.agent_detected`, which fires only after `agent start`"), so the brief physically cannot be
delivered to a worker at dispatch. It goes to the orchestrator, which runs `agent start` with it.
That is what `cmdTask` does today: it renders `renderWorkerPrompt` and returns it on the CLI's own
stdout, in the orchestrator's turn.

This is not pedantry in this document. BLOCKER 4's entire fix is "`nextDelivery` returns `Delivery[]`
**grouped by target pane**" (spec:478-479). The grouping key is the recipient. §Prompts is the table
an implementer will read to build that grouping, and for the single highest-volume prompt in the
system it names the wrong pane — one that does not exist yet. The `table.test.ts` invariant
("every row naming a `prompt` or `resumePrompt` names a file present in `prompts/`", spec:559-560)
checks the filename, not the recipient, so nothing catches it.

There is a second, quieter contradiction in the same row-pair: §Prompts also lists `worker-brief.md`
under "new", while §Roles (spec:88-95) describes it as the thing `hpipe task` stops rendering with
`--text`. `renderWorkerPrompt` (`src/lib/worker-prompt.ts`) supplies `task_text: task.text`; with
`Task.text` removed that function must change, and §Code shape's change list does not name it.

**What breaks:** An implementer building per-pane grouping from §Prompts routes the worker brief to
`task.pane_id`, which is `null` at `queued`. Under v2's own rule a task with `pane_id === null` is
"skipped by predicate evaluation each tick — not an error" (spec:226-227), so the brief is silently
dropped and the task sits in `research` forever — which is exactly the unprobeable state round 1's
MAJOR 2 was written about.

**Smallest fix:** Change the §Prompts cell to "orchestrator, at gate-open (relayed to the worker by
`agent start`)", and add `src/lib/worker-prompt.ts` to §Code shape's change list.

---

# MINORS

## MINOR 1 — "increments and tests that value" contradicts the worked example three paragraphs below it. `MAX_PASSES = 2` means either one remediation attempt or two.

**Location:** spec:161-162 vs spec:172-176.

spec:161-162 specifies increment-then-test: "A review row's `onBlocker` **increments**
`passes[reviewPhase]` **and tests that value** against `MAX_PASSES`." Under that rule at
`MAX_PASSES = 2`: first BLOCKER → `1`, `1 >= 2` false, return to producer; second BLOCKER → `2`,
escalate. Two reviews, one remediation.

spec:172-176 argues from the opposite order: "a task that took two passes at `spec-review` arrives at
`plan-review` holding `pass = 2` and escalates on its first BLOCKER, **because the implementation
tests `pass >= maxPasses`**." Reaching `pass = 2` while still alive requires test-then-increment
(`advanceTask` tests, then `task.pass += 1`). Under that rule the same phase gets three reviews and
two remediations.

§Testing then asks for "a trace asserting `spec ↔ spec-review` **escalates** at `MAX_PASSES`"
(spec:546-547), which is unwritable until the order is pinned. Round 1's MINOR 1 was an arithmetic
slip of exactly this shape in exactly this paragraph. **Fix:** state the order once — "`onBlocker`
tests `passes[reviewPhase] ?? 0 >= MAX_PASSES` first, escalating if so, then increments" — and make
the §Testing trace name the expected number of review turns.

## MINOR 2 — `{{task_text}}` was fixed; `{{pass}}` is the same defect in two prompts the same table calls "kept … as before".

**Location:** §Roles (spec:88-95); §Prompts "kept" row (spec:393); §`passes` is keyed by phase
(spec:159-160). Round 1's MINOR 4, **displaced**.

v2 removes `Run.pass` and `Task.pass` (spec:159-160) and separately states the rule that makes that
dangerous: "`render()` throws on an unresolved placeholder, so a `worker-brief.md` that inherits it
dies on first dispatch" (spec:94-95). It then lists `branch-review.md` and `escalate.md` as kept
unchanged. Both contain `{{pass}}`:

```
$ git show feat/plugin-implementation:prompts/branch-review.md | grep -o '{{[^}]*}}' | sort -u
{{pass}}  {{run_id}}  {{spec_path}}  {{verdict_path}}
$ git show feat/plugin-implementation:prompts/escalate.md | grep -o '{{[^}]*}}' | sort -u
{{pass}}  {{phase}}  {{run_id}}  {{task_flag}}
```

`promptForRunPhase` and `promptForTaskPhase` both supply it as `pass: String(run.pass)` /
`String(task.pass)`. TypeScript will catch the field removal, so this costs an hour, not a run — but
it is the identical class, created by the section that states the rule. **Fix:** one clause on the
"kept" row — "`branch-review.md` and `escalate.md` re-source `{{pass}}` from `passes[phase] ?? 0`" —
and add "every placeholder in a prompt is supplied by its call site" to `table.test.ts`.

## MINOR 3 — Verdict keys reset to `-0` on any lap through `pr-review-quality` or `ci`, contradicting §Artifacts' own guarantee.

**Location:** §Artifacts (spec:364-366): "Verdict keys are `<phase>-<passes[phase] ?? 0>` within the
task's own map, **so pass 1 cannot overwrite pass 0's file**."

True within one uninterrupted loop. False on the two paths the table makes normal. A
`pr-review-quality` BLOCKER returns to `implement`, which re-enters `pr-review-intent`, whose
previous `CLEAR` deleted `passes[pr-review-intent]` — so the key renders `pr-review-intent-0` again
and the second intent review overwrites the first. A CI-red lap resets both PR review keys the same
way. No *false advance* results (`isFresh` compares against the re-set `phase_entered_at`, so a stale
file is correctly ignored), but the record §Failure modes calls "the backstop" — "the verdict files
landing in the PR" (spec:531) — is silently destroyed each lap. **Fix:** either key the verdict on a
monotone per-task review sequence number rather than `passes[phase]`, or say plainly in §Artifacts
that only the most recent verdict per phase survives in the working tree and git history is the
record.

## MINOR 4 — `table.test.ts`'s prompt glob catches `branch-review.md`, which must not carry either instruction.

**Location:** §Testing (spec:561-562): "every `prompts/*-review*.md` contains both the await
instruction and the commit-and-push instruction."

`*-review*.md` matches `spec-review.md`, `plan-review.md`, `pr-review-intent.md`,
`pr-review-quality.md` — and `branch-review.md`, which §Prompts lists as kept unchanged and which is
the **orchestrator's** run-level phase. It dispatches no subagent, writes to the main checkout, and
has no branch to push a verdict to. The test as specified fails against the design's own prompt set,
and the natural resolution (weaken the glob) is what the invariant exists to prevent. This is round
1's MINOR 2 recurring in the very test written to close it.

Separately: §Code shape's `PhaseRow` cannot express the run `execute` row, whose success is
"`branch-review` if ≥1 task is `done`, else `escalated`" (spec:94) — one `onClear` field, two
successors. The claim "One table in `machine.ts` is the single source of phase knowledge" (spec:444)
is therefore slightly overstated, and `table.test.ts` validates a shape the machine does not fit.
**Fix:** name the four worker review prompts explicitly instead of globbing, and give `PhaseRow` an
`onClearIf` (or state that `execute`'s branch is code, not table).

## MINOR 5 — `close` still deadlocks permanently when the issue was closed before the merge.

**Location:** Task table `close` row (spec:145): "`closed` is true **and** `closedAt >=
merged_at_ms`".

The fix for round 1's BLOCKER 2 is correct on the auto-close path and I verified `gh`'s field names
and `src/lib/gh.ts`'s `issueView`. But `closedAt` is immutable and the comparison is one-sided. If the
issue was already closed when the PR merged — a duplicate the human closed by hand, an issue a
sibling task's PR closed first, a `Closes #n` in an earlier PR — then `closedAt < merged_at_ms` and
the predicate is false on the first tick and every tick after. `close` is not terminal, so
`execute`'s "every task terminal" never fires and the run hangs. It is a narrower case than round 1's
(which was unconditional), but the failure mode and the absence of an escape are identical. **Fix:**
`closed && (closedAt >= merged_at_ms || closedAt < phase_entered_at(merge))` — an issue closed before
the work began is closed, full stop.

## MINOR 6 — Round 1's `close.md` delivery note was dropped, so the orchestrator is prompted to close an issue that is already closed on a phase it leaves next tick.

**Location:** Task table `close` row (spec:145); §Prompts "kept" row (spec:393).

Round 1's smallest fix for BLOCKER 2 had two parts; v2 applied the predicate and not the note ("a
task whose issue is auto-closed passes `close` on the first evaluation by design, so the `close.md`
prompt must be delivered at `merge` → `close` entry or not at all"). In the implementation
`promptForTaskPhase` renders `close.md` on entry to `close`, and `close` is in `ORCHESTRATOR_OWNED`
so it also consumes an actor-idle gate. Under the corrected predicate the task leaves `close` on the
next evaluation, so the orchestrator receives a prompt telling it to close an issue that GitHub
already closed, for a task that has already moved to `teardown` — a wasted orchestrator turn per task
and a confusing one. **Fix:** restore round 1's note, and say `close.md` is either dropped from the
prompt set or reduced to a verification line.

---

# Verification

## Verified with evidence — v2's claims about the implementation

All read from `feat/plugin-implementation` via `git show feat/plugin-implementation:<path>`.

| v2 claim | Location | Verdict | Evidence |
| --- | --- | --- | --- |
| `nextDelivery` returns **one** `Delivery`, `main.ts` joins prompts with `\n\n---\n\n` | spec:476-478 | **TRUE** | `src/supervisor/deliver.ts`: `nextDelivery` returns on the first non-empty input, `paneId: input.run.orchestrator_pane`. `src/supervisor/main.ts`: `[nextPrompt, ...taskPrompts].filter(…).join('\n\n---\n\n')` |
| `applyEvents` writes `failed` from any phase with no guard | spec:283-284 | **TRUE** | `src/supervisor/tick.ts`: both the `pane.exited` and the `released === true` branches call `enterTaskPhase(run, task, 'failed', …)` unconditionally |
| `cmdRewind` sets `pass = 1` | spec:177-179 | **TRUE** | `src/cli.ts`, `cmdRewind`: `task.pass = 1` / `run.pass = 1`; returns "pass reset to 1". v4's document says "resets `pass` to 0" (v4:496, v4:568) — v2's diagnosis of the discrepancy is correct |
| `listRuns` casts blindly | spec:515-517 | **TRUE** | `src/lib/ledger.ts`: `readJson<Run>(…)`, pushed with no shape check |
| `activeRunForRepo` treats any non-`done` run as active | spec:521-523 | **TRUE** | `src/lib/ledger.ts`: `!COMPLETED_RUN_PHASES.has(r.phase)`, and `COMPLETED_RUN_PHASES = new Set(['done'])` in `src/lib/machine.ts`. `cmdStart` refuses on a hit |
| `render()` throws on an unresolved placeholder | spec:94-95 | **TRUE** | `src/lib/render.ts`: `if (value === undefined) throw new Error(\`unresolved template placeholder: ${name}\`)` |
| `worktree.created` carries a checkout path `applyEvents` discards | spec:369-373 | **TRUE** | `src/hooks/_hook.ts`: `if (raw.worktree?.path) event.checkout_path = raw.worktree.path`. `src/supervisor/tick.ts`'s `worktree.created` branch sets only `workspace_id` |
| `MAX_PASSES` defaults to **2** | spec:26, spec:509 | **TRUE** | `src/lib/config.ts`: `MAX_PASSES: 2` |
| `teardown.ts` already advances on `every(SETTLED)` | spec:26-27, spec:124-127 | **TRUE** | `src/supervisor/teardown.ts`: `run.tasks.every((t) => SETTLED.has(t.phase))`, `SETTLED = {done, failed, orphaned, blocked-on-failure, escalated}` — v2's terminal set exactly |
| `plugin.action.invoke` accepts no user arguments → commands in `src/cli.ts` | spec:490-493 | **CONSISTENT** | Every file in `src/actions/` (`claim`, `drain`, `status`, `supervisor`) takes no arguments; `hpipe` parses `--flag` pairs in `src/cli.ts`'s `dispatch` |
| `merge` reads `state === 'MERGED'` | spec:144 | **TRUE** | `src/lib/gh.ts`: `prView` queries `state,mergedAt,headRefOid` and derives `merged: view.state === 'MERGED'` |
| **"retries are bounded by `PROMPT_RETRY_MAX` (5) at `TICK_MS` (1000)"** | spec:317-318 | **FALSE of the code** | `src/supervisor/main.ts` never re-sends a failed delivery; `attempts` counts consecutive failures of different deliveries and resets on give-up. True of the v4 *document* (v4:535-536) only. → MAJOR 2 |
| **"the single module-level `attempts`"** | spec:480 | **FALSE, trivially** | `let attempts = 0` is function-scoped inside `main()` |
| **"The stall probe covers it" (run stuck in `execute`)** | spec:541 | **FALSE** | `stallCandidates` gates on `ARTIFACT_RUN_PHASES.has(run.phase)`; `ARTIFACT_RUN_PHASES` excludes `execute`. `taskStallCandidates` gates on `task.phase === 'execute'`, and every task is terminal in this scenario. → BLOCKER 2 |
| **`ci` has no retry bound in v2's table** | spec:143 | **REGRESSION** | `src/lib/machine.ts`, `advanceTask` case `'ci'`, tests `task.pass >= s.maxPasses` and escalates, with a comment naming the loop it prevents. `Task.pass` is deleted by spec:159-160. → BLOCKER 1 |
| **`adopted_at` can only be written once** | spec:93, spec:106 | **CONFIRMED** | `src/supervisor/tick.ts`'s `worktree.created` branch matches on `t.workspace_id === null`; after the first adoption no later event matches. → MAJOR 3 |
| **`workerIdle` is cached, `actorIdle` is live + double-checked** | spec:483-484 | **CONFIRMED** | `src/supervisor/tasks.ts`: `workerIdle: isAgentReady(task.agent_status)`. `src/supervisor/deliver.ts`: live `herdr.agentStatus`, `Bun.sleep(ACTOR_SETTLE_MS)`, second read. → MAJOR 4 |
| **`{{pass}}` survives in two "kept" prompts** | spec:393 | **CONFIRMED** | `prompts/branch-review.md` and `prompts/escalate.md` both contain `{{pass}}`. → MINOR 2 |
| **`prompts/task.md` mandates `Closes #{{issue}}`** | spec:412-417 | **TRUE** | Read verbatim; "Implements #n … will be treated as a failure" |

## Verified with evidence — environment

```
$ herdr --version
herdr 0.9.0

$ herdr integration status | grep claude
claude: outdated (v7 < v9) (/Volumes/stein/.claude/hooks/herdr-agent-state.sh)

$ gh --version
gh version 2.96.0 (2026-07-02)
```

v2's §Prompts claim that "on this machine the claude integration is v7, which reports no state at all
… so status is entirely screen-scraped with no hook backstop" (spec:403-405) is consistent with the
above and with round 1's reading of the v7 hook. The `background_agents_working` rule and its
priority I did **not** re-derive — see below.

## Could not verify

- **Whether a Claude Code subagent perturbs its parent pane's reported `agent_status`.** Still open,
  and still the assumption under four of v2's twenty task rows. I did not stage a live pane with a
  running subagent. My assessment of v2's fix, which is what the caller asked for: a prompt
  instruction is *not* sufficient for a predicate-level assumption, and v2 says so itself
  (spec:530 — "the prompt is an instruction, not a guarantee"). What makes it *acceptable* is
  something v2 states only in passing: the verdict-file freshness predicate is an independent guard,
  so a backgrounded subagent produces a delay, not a false advance. The residual damage is exactly
  what spec:406-410 says — a `TASK_STALL_MINUTES` clock against a healthy worker, and the actor-idle
  gate losing its meaning for those rows. That is priced. **`table.test.ts`'s grep, however, tests
  nothing that matters**: it asserts a string is present in a file, which was never in doubt; it
  cannot assert the agent obeys it, and — see MINOR 4 — the glob it uses is wrong. It is a
  regression guard against someone editing the instruction out, and should be described as that
  rather than as part of "the class-level check".
- **Whether `closedAt` can land before `mergedAt` on the auto-close path.** I did not merge a live
  PR. MINOR 5 does not depend on the measurement: it concerns an issue closed *long* before the
  merge, where the ordering is not in question.
- **The claimed herdr detection-rule priorities** (`background_agents_working` 965 vs
  `live_prompt_box` 950). I did not re-run `herdr agent explain --json` against a live pane; round 1
  did, and v2 restates it accurately as far as the manifest version and the rule's existence go.
- **Whether two `hpipe` processes and the supervisor can interleave writes to one run file.**
  `saveRun` is a whole-file `writeJson` with no lock, and `intake_closed` is now written by
  `hpipe task`, `hpipe dispatch --done` and read by the supervisor's tick. I did not construct the
  race, and v2 inherits v4's ledger model unchanged, so I am not filing it — but it is worth noting
  that `intake_closed` is the first flag whose *correctness* (rather than freshness) depends on
  last-writer-wins between the CLI and the supervisor.

## Things I checked and found sound

- The per-phase `passes` map genuinely bounds `spec ↔ spec-review`, `plan ↔ plan-review` and
  `implement ↔ pr-review-*`. Traced row by row against v2's own table; the "no transition into a
  review phase ever resets that phase's own counter" formulation is the right rule and v1's was not.
- `hpipe rewind` clearing the map rather than setting `1` is correct against v4's stated intent
  (v4:496-497) and against `cmdRewind`'s actual behaviour.
- The `blocked-on-decision` guards (refuse a second `decide`, refuse `answer` on a non-blocked task,
  abandon open decisions on pane death) are the right three and close round 1's BLOCKER 5 and MAJOR 3
  as written.
- `holdsFiles: 'inherit'` resolved through `decision_from` is the correct treatment of
  `blocked-on-decision`, and the reasoning given for it is right.
- `Delivery[]` grouped by pane, with the digest header attached only to the orchestrator's message,
  is the correct shape for BLOCKER 4, and restating the coalescing rule as "at most one advance per
  actor pane per tick" is the class-level version of round 3's MAJOR 6 rather than another instance.
- `execute` → `escalated` when no task is `done` remains a genuine improvement over
  `teardown.ts`'s unconditional `branch-review`.
- The `src/cli.ts` placement, the `schema_version: 2` migration, the corrected migration message, and
  the `MAX_PASSES = 2` correction are all right and all verified.
- Keeping `research` as its own artifact, and the reason given for it, remain well-argued — this
  review is again the worked example.

VERDICT: BLOCKER
BLOCKERS: 2
MAJORS: 5
