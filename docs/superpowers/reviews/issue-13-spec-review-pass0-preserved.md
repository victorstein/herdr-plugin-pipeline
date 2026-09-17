# Adversarial spec review — issue #13, pass 0

**Target:** `docs/superpowers/specs/2026-09-17-issue-13-design.md`
**Against:** issue #13 (`gh issue view 13`), `docs/superpowers/research/2026-09-17-issue-13-research.md`
**Tree:** `fix/13-digest-content` @ `f77f4bb`, worktree
`/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-13-digest-content`, clean.
**Gates re-run here:** `bun test` → `414 pass / 0 fail / 903 expect() / 33 files`; `bun run typecheck`
→ exit 0. Both match the spec's §Whole-suite gate claim.

## What checks out

Most of the spec's empirical scaffolding is correct and I could not break it. Verified directly:

- **The rung ladder is exhaustive over `TASK_ROWS` and the spec's enumeration is exact.** Re-run:
  `bun -e` over `TASK_ROWS` with the spec's rung 1–6 predicates classifies all **20** rows, with the
  same `actor`/`terminal` values the spec prints — `queued`/`blocked-on-files`/`ci`/`teardown` → 6,
  eight `worker` rows → 5, `merge`/`close`/`blocked-on-decision` → 4, `escalated` → 3,
  `failed`/`orphaned`/`blocked-on-failure` → 2, `done` → 1. Rung 1 before rung 2 is load-bearing and
  the spec has the order right.
- **C1's diagnosis is correct.** `findTask` (`src/supervisor/tick.ts:17-23`) returns the live `Task`
  out of `run.tasks`; `applyEvents` runs at `src/supervisor/main.ts:122`; `advanceTasks` mutates the
  same object at `:177`; the lines are assembled at `:212`. Composing the phase at `tick.ts:88`
  would indeed name a phase the task has already left.
- **A3 holds against every in-tick mutator.** Everything that can move `task.phase` between
  `applyEvents` and `:212` stamps `phase_entered_at = Date.now()` in the same tick —
  `src/lib/machine.ts:94` reached via `advanceTasks` (`:177`), `deliverPendingAnswers`
  (`src/supervisor/tasks.ts:341`, at `main.ts:204`), `teardown.ts:28,34`, and `applyEvents`' own
  forced `failed` (`tick.ts:63,74`). `ciTransitions` (`main.ts:141`) calls `enterTaskPhase` nowhere
  (`grep -n enterTaskPhase src/supervisor/ci.ts` → no hits). `stall.ts:298` fires at `main.ts:287`,
  after delivery. So an arrow always coincides with a 0m age, as claimed.
- **The `stallAwaiting` rejection is fairly evidenced.** Read against
  `src/supervisor/stall.ts:161-219`: `queued` has `signal: 'gate'` → `'intake to be closed'`
  (`:212-217`) — false for a task; `failed`/`done`/`orphaned`/`blocked-on-failure` are `signal:
  'manual'` → `'an answer to the open decision'` (`:204`); `ci`/`merge` fall through to
  `whatever clears ${phase}` (`:218`), pinned as the fallback by `test/stall.test.ts:307-315`;
  `teardown` → `'its worktree to be removed'` (`:205-211`). Every sentence in the spec's probe block
  is reproducible from the source.
- **The blast-radius claim for `test/tick.test.ts` is true.** The four wake-producing tests at
  `:71`, `:80`, `:98`, `:114` discard `applyEvents`' return value; the only tests touching `wake` are
  `:53-60` and `:62-69`, both `toHaveLength(0)`. Nothing reads `.text`.
- **The orphan-template claim is true.** `grep -rn digest src/` → exactly one hit,
  `src/supervisor/deliver.ts:39` (a comment). No `renderPrompt` site names `digest`.
  `test/prompts.test.ts:12` hand-lists `'digest'` in `ALL`, which `:21-24` checks against.
  `docs/superpowers/plans/2026-09-15-worker-owned-pipeline.md:2995` and
  `docs/superpowers/reviews/2026-09-13-design-adversarial-2.md:624` both say so.
- **The ledger evidence is real.** `t2 [done] agent_status=working`, `t3 [merge] agent_status=done`,
  `79` history entries spanning `20h1m`. `t1.files` in the sibling ledger is
  `["src/cli.ts","prompts/intake.md","prompts/dispatch.md","README.md"]` and `t2.files` is
  `["src/supervisor/tick.ts","src/supervisor/deliver.ts","prompts/digest.md"]`, exactly as A11 quotes.
- **Most `file:line` citations land.** `status.ts:12-14`/`:13`/`:23-25`/`:46-62`/`:135`/`:136`,
  `types.ts:5`/`:71`/`:72`, `machine.ts:94`, `badges.ts:14`/`:16`, `gating.ts:19-21`/`:19-29`/`:49-53`,
  `tasks.ts:17-22`/`:171-175`, `phases.ts:12`/`:89-141`/`:105-106`/`:120-121`, `render.ts:8-14`/`:28-38`,
  `config.ts:24`, `smoke.md:164-165`, `prompts.test.ts:12`/`:21-24`, `deliver.test.ts:33-51`/`:53-81`
  all check out. The spec also silently corrects the research note's `status.ts:134` to `:135`.

The findings below are what survived.

---

## BLOCKER 1 — the design's headline case (`[merge 41m] … YOUR move`) cannot be produced, and A9's justification rests on it

**Claim.** Spec:40-41: *"`t3` is the issue's failure mode exactly: a line reading `t3 … done` for a
task parked in `merge`, unmerged."* Spec:243 renders it as
`- t3 fix/37-gate-screen-rotation (#37) [merge 41m] agent:done — YOUR move`. Spec:250: *"The third
line is the one the issue was filed over."* A9 (spec:396-403) declines the roster because
*"Rungs 1–6 make that line sufficient."*

**Problem.** A digest line exists only where `applyEvents` pushed a `WakeLine` — the design does not
change that (`src/supervisor/main.ts:212`, flow step 9). There are exactly three producers
(`src/supervisor/tick.ts:64`, `:75`, `:88`), all driven by herdr pane events about the **worker's**
pane. The spec says so itself in §Non-goals (spec:107-108): *"A task parked in `merge` emits no event
and `merge` has no `stallable` flag … so nothing nudges it."* Those two statements cannot both be
true: if merge emits no event there is no `WakeLine`, and `[merge 41m] agent:done — YOUR move` is
never composed. Rung 4 — the only rung that asks the orchestrator to act — can fire only on the
incidental tick where a pane event happens to coincide with the task already sitting in an
orchestrator-owned row, and on exactly that tick `promptForTaskPhase` already delivers
`prompts/merge.md` to the same pane (`src/supervisor/tasks.ts:175`; `actorPane` at
`src/supervisor/tasks.ts:117-119` returns `run.orchestrator_pane` for a non-worker row;
`src/supervisor/main.ts:214-216`). A7 (spec:384-388) reasons explicitly about *"a tick where the row
was entered earlier"* — the case that produces nothing.

**Evidence.** From the live ledger the spec cites
(`~/.local/state/herdr/plugins/stein.pipeline/runs/personal/berean-os-20260916-berean-os-issue-batch-ujku.json`):

```
t3 history:  … 2026-09-16T22:47:13.655Z pr-review-quality -> ci   | cleared
                2026-09-16T22:47:27.752Z ci                -> merge | cleared
last entry:     2026-09-17T03:44:34.471Z execute -> done          | aborted from execute
t3.phase_entered_at = 2026-09-16T22:47:27.752Z
t3.agent_status     = "done"   (frozen)
```

t3 sat in `merge` for **4h57m** and the run was then aborted. `applyEvents` writes
`task.agent_status = event.agent_status` on every applied status event
(`src/supervisor/tick.ts:84-85`), and a same-value event is dropped at `:84` without pushing a wake
line — so a frozen `agent_status` over that window means **zero** wake lines for t3, and therefore
zero digest lines, under both today's code and this design. The `[merge 41m]` line is not something
the run failed to say well; it is something the mechanism never says at all. By the same token,
spec:40-41's "a line reading `t3 … done` for a task parked in `merge`" was never delivered while t3
was parked — the last t3 line the orchestrator saw was at or before 22:47.

This is why *"every digest was followed by `hpipe status`"*: the thing the orchestrator needed to
know was the state of tasks that were **not** in the digest. Rungs 1–6 improve every line that
exists; they do not create the lines that are missing, and the missing ones are the only ones with a
`YOUR move` in them.

**Concrete fix — a decision only the human can make.** Pick one and write it into the spec:

1. **Take the cheap half of A9.** Not a full roster: a bounded footer on the orchestrator digest
   listing non-terminal tasks where `taskRow(task.phase).actor === 'orchestrator'`, one line each
   (`t3 fix/37-… (#37) [merge 41m] — YOUR move`). On the berean-os run that is 0–1 lines per digest,
   not ~6, which removes A9's stated cost (spec:398-400) while satisfying the issue's acceptance
   sentence for the only rows where the orchestrator has a move. It is additive to `buildDigest`,
   which A9 already concedes is "a bounded, additive change".
2. **Declare #19 a prerequisite** and say the parked case is closed there, not here.
3. **Accept the gap explicitly** — but then delete the t3 worked example (spec:243), the sentence at
   spec:250, and the framing at spec:40-41, and restate the Goal as "every line the digest *does*
   carry is honest and actionable", which is what the design actually delivers.

Option 3 alone leaves #13 open against its own acceptance sentence, which is a scope call, not an
editing call. Nothing else in the spec should ship with the current framing intact.

---

## MAJOR 1 — the blocked pane tail is still gated on the stale cache the design was written to indict

**Claim.** Flow step 3 (spec:269-270): *"Blocked-tail loop (`:124-131`). **[C1]** Writes
`line.detail` instead of `line.text +=`. The `herdr.paneRead` call, the `BLOCKED_TAIL_LINES` slice
and the trim are unchanged."* A2 (spec:342-344) leans on that tail: *"`blocked` in particular carries
the pane tail …, which is the most actionable text in any digest."*

**Problem.** The loop's *gate* is `line.task?.agent_status === 'blocked'`
(`src/supervisor/main.ts:125`) — the field the spec's own Problem section quotes
`src/supervisor/tasks.ts:17-22` calling *"the badge and wake cache [that] can be stale by a whole
turn"*. It is not the status of **this** event; it is the last status applied to that task in the
whole batch. `drain` returns the entire queue directory in one call and unlinks as it goes
(`src/lib/queue.ts:30-52`), and the default `WAKE_ON` is
`['blocked','done','idle','unknown','exited','released']` (`src/lib/config.ts:25`), so a worker
crossing `blocked → idle` inside one drain produces **two** wake lines and, by the time the loop at
`:124` runs, `task.agent_status === 'idle'`:

- the `agent:blocked` line silently loses its tail — the most actionable text in the digest, per A2;
- in the reverse order (`idle → blocked`) **both** lines get the tail, so an `agent:idle` line
  carries a blocked pane's screen.

C1 is the fix and the spec declines to use it: after C1 the correct key is sitting on the line.

**Concrete fix.** In flow step 3, gate on the event rather than the cache:

```ts
for (const line of wake) {
  if (line.event === 'agent:blocked' && line.task?.pane_id) { … line.detail = tail.trim() }
}
```

and add a T-case the table currently lacks: two `pane.agent_status_changed` events for one task in
one `applyEvents` call (`blocked` then `idle`), asserting the tail lands on the `agent:blocked` line
and not on the `agent:idle` one. The design edits `main.ts:124-131` regardless, so this is inside
the diff it already takes.

---

## MINOR 1 — A4 answers the format question and drops the duplication question its own research raised

**Claim.** A4 (spec:357-361): *"Bare minutes, `Nm`, copied from `src/lib/status.ts:12-14`."* §Error
handling repeats *"`Math.max(0, …)`, copied from `src/lib/status.ts:13`"*.

**Problem.** The research note flags this under §Constraints the spec inherits: *"Age formatting
exists twice already and is exported neither time: `status.ts:12-14` (`ageMinutes`, module-private)
and `stall.ts:70` (inline, `MS_PER_MINUTE`). A third copy would be the third."* Verified:
`src/lib/status.ts:12` is `function ageMinutes(…)` with no `export`, and `src/supervisor/stall.ts:70`
is `Math.floor((now - record.phase_entered_at) / MS_PER_MINUTE)` with **no** `Math.max(0, …)` clamp.
A4 settles only *which format*; the spec never says whether it duplicates or shares, and by silence
chooses a third implementation, two of which clamp and one of which does not. With #14 actively
editing `status.ts`, this is the moment the call has to be made, not later.

**Concrete fix.** Add one sentence to A4: either *"a third private copy is accepted because
`status.ts` is #14's file and §Non-goals forbids touching it"*, or move a single exported
`ageMinutes` into a neutral module and import it from `tick.ts` (that is one more file outside the
declared set, which A11 already has the machinery to declare).

## MINOR 2 — rung 3 is not "copied from status.ts"; the divergence is the reason `describeWake` takes `hpipe` at all

**Claim.** Spec:216: *"Rung 3's string is copied from `src/lib/status.ts:23-25`, which composes the
identical rewind invocation for the identical state; it is not invented here."*

**Problem.** `src/lib/status.ts:25` hardcodes the literal word `hpipe`
(`` `\`hpipe rewind ${run.run_id} ${task.escalated_from ?? '<phase>'} --task ${task.task_id}\`` ``).
The design renders it through `hpipeCommand(pluginRoot)` (`src/lib/render.ts:28-38`) — which is the
correct form, per that function's own doc-comment (*"a plugin installed from GitHub has no `hpipe`,
and every prompt that names one would be uninvokable"*) — and that single divergence is the entire
reason `describeWake` needs its third parameter and flow step 6 needs the `hpipe` hoist. An
implementer who reads "copied … not invented here" literally drops the parameter, deletes the hoist,
and ships `hpipe rewind …` to an orchestrator with no `hpipe` on PATH.

**Concrete fix.** Rewrite as: *"rung 3 mirrors `status.ts:23-25`'s invocation and its
`escalated_from ?? '<phase>'` fallback, but renders the CLI through `hpipeCommand` rather than the
literal `hpipe` that `status.ts` uses; that divergence is why `describeWake` takes `hpipe`."* The
`status.ts` literal is a latent defect worth naming to #14.

## MINOR 3 — A11 miscounts the files outside the declared set, and contradicts the precedent it cites

**Claim.** Spec:8 and A11 (spec:412-423): *"Two files outside it are needed"* —
`src/supervisor/main.ts` and `test/prompts.test.ts`.

**Problem.** §Testing strategy also adds fourteen cases plus the exhaustiveness guard to
`test/tick.test.ts`, which is not in `t2.files` either — so the list is three, not two. And the
precedent A11 cites (`docs/superpowers/specs/2026-09-17-issue-9-design.md:517-524`) settles it the
other way: *"`--files` declares the implementation surface and its tests follow it"* — under which
the answer is **one** (`src/supervisor/main.ts`). Either count is defensible; naming exactly one of
the two test files is not.

The gate conclusion is unaffected and I re-verified it: `t1.files` from the live ledger is
`["src/cli.ts","prompts/intake.md","prompts/dispatch.md","README.md"]`, and `filesOverlap`
(`src/lib/gating.ts:19-21`) finds no prefix pair against `src/supervisor/main.ts`,
`test/prompts.test.ts` or `test/tick.test.ts`.

**Concrete fix.** *"One source file outside the declared set: `src/supervisor/main.ts`. Test files
follow the implementation surface per the issue-9 convention; this change edits `test/tick.test.ts`
and `test/prompts.test.ts`."*

## MINOR 4 — rung 1 answers a different question than rungs 2–6, in the word the issue was filed over

The Goal (spec:87-88) says the `<action>` clause answers *"whether the line is asking anything of
them"*. Rungs 2–6 all do. Rung 1 renders the bare word `done`, restating the phase box and ending
the line in the exact token the issue complained about: `[teardown → done] agent:done — done`. T4
pins only that it must not say "needs a human".

**Fix.** `nothing for you — this task is finished`, and extend T4 to assert the clause answers the
actor question rather than repeating the phase.

## MINOR 5 — §Error handling asserts `describeWake` is "total" and then tables an input that throws

Spec:312 — *"`describeWake` is pure, synchronous, total"* — and two rows later, *"An unknown phase
string | `taskRow` throws (`src/lib/phases.ts:145-148`)"*. Both cannot hold. The throw is in fact
unreachable at `:212` because `advanceTasks` already calls `taskRow(task.phase)` at
`src/supervisor/tasks.ts:159` inside the same `try` and kills the tick first — say that instead of
asserting totality. While there, the preamble understates the cost of a throw at `:212`: the `catch`
at `main.ts:219` skips not only `addPending` (`:213`) but `saveRun` (`:218`), so the tick's
`advanceTasks` transitions are lost from the ledger, not just the prompt. (Also: `taskRow` spans
`src/lib/phases.ts:145-149`, not `:145-148`.)

## MINOR 6 — two evidence sentences in §Problem overstate what the ledger shows

- Spec:33 — *"has it frozen for **2** of its 6 tasks at rest"*. It is **3**: alongside
  `t2 [done] agent_status=working` and `t3 [merge] agent_status=done`, the ledger also holds
  `t6 refactor/31-unused-i18n-keys #31 [plan-review] agent_status=done` — which under today's line
  renders *"`refactor/31-unused-i18n-keys (#31, t6) done`"* for a task sitting in `plan-review`, i.e.
  a second instance of the exact failure mode. The spec undercounts its own best evidence.
- Spec:41-42 — *"That run's `history` holds 79 transitions over 20h01m against the ~50 digests the
  issue counts, so the majority of digests carried no transition at all."* The counts are right (79,
  20h01m, both re-verified) but the inference does not follow: 79 > 50 means, if anything, more than
  one transition per digest on average. The research note's version of the point is the sound one
  and should be used instead — of the 79, only the **3 run-level** transitions can reach the digest
  at all, because `phaseNote` is composed from `evaluateRun`'s run transition only
  (`src/supervisor/deliver.ts:67`, `:236`); all 76 task transitions are invisible to the digest by
  construction.

This is the `0aa1dbf` class of defect the spec names as its model — a sentence that is not true of
what it cites — reproduced in the document that argues against it.

---

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 1
