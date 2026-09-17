# Adversarial spec review — issue #13, pass 2 (v3; path recycled by the counter reset)

**Target:** `docs/superpowers/specs/2026-09-17-issue-13-design.md` (**v3**)
**Against:** issue #13 (`gh issue view 13`, including the **Scope ruling of 2026-09-17**),
`docs/superpowers/research/2026-09-17-issue-13-research.md`, and both prior passes —
`docs/superpowers/reviews/issue-13-spec-review-pass0-preserved.md` (`BLOCKER`, 1/1/6) and
`docs/superpowers/reviews/issue-13-spec-review-1.md` (`BLOCKER`, 1/2/4).
**Tree:** `fix/13-digest-content` @ `3933a0d`, worktree
`/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-13-digest-content`, clean.
**Gates re-run here:** `bun test` → `414 pass / 0 fail / 903 expect() / 33 files`; `bun run typecheck`
(`tsc --noEmit`) → exit 0. Both match §Whole-suite gate's claim at `2caa714`.
**Ledger re-dated:** berean-os ledger re-read **2026-09-17 16:56 local** (mtime 16:54:00 — the file
moved since pass 1's 14:22 read). Still **80** history entries, last still
`t4 done -> blocked-on-decision` at `2026-09-17T20:05:44.516Z`. Every dated figure in the spec's
14:12 read still reproduces; t3's `merge` park is now **~24h**, not the `~21h` the spec's dated read
says, which is correct *as dated* and is flagged here only so a later pass re-dates rather than
re-asserts.

## Audit of the two disposition tables

### Pass 1 (`§What changed from v2`)

| Finding | Claimed | Found |
|---|---|---|
| **BLOCKER 1** — §Resolution overrides the human; A10's sizing falsified | Accepted in full, per the ruling | **Genuine in substance, one clause short of where the ruling put it** — MINOR 1 |
| **MAJOR 1** — required `DigestInput.footer` breaks three `buildDigest` literals | Accepted | **Genuine and complete.** `footer?: string` / `input.footer ?? ''` (spec:417-424), A15 (spec:667-672), T27 (spec:736), and `test/deliver.test.ts:121-130` is now on the unchanged list (spec:757-762). The three literals are at `:34`, `:47`, `:124` exactly as claimed |
| **MAJOR 2** — footer excludes `escalated`; `hpipe` dead | Accepted | **Genuine and complete, and the better of the two offered options.** Predicate widened (A16, spec:675-685), ladder extracted as shared `actionFor` (spec:328-331), T24/T25/T26 added, exhaustiveness guard now covers both callers (spec:738-745) |
| **MINOR 1** — `WakeLine.event` doc comment | Accepted | **Genuine.** spec:253-260 now says the `agent:` prefix is applied at push and names `main.ts:125` as the reason |
| **MINOR 2** — five intervals mislabelled `close` | Accepted | **Genuine.** I re-derived occupancy from `run.history`: exactly four `close` (t4 0m, t1 1m, t5 0m, t2 2m) and one `blocked-on-decision` (t4, open since `2026-09-17T20:05:44.516Z`). spec:160-161 now says so |
| **MINOR 3** — A11's test enumeration | Accepted | **Genuine.** All three test files named (spec:635-641) |
| **MINOR 4** — suppression gate is `main.ts:160` | Accepted | **Genuine.** `main.ts:160` cited first at spec:519 and spec:603-605, `deliver.ts:53` demoted to backstop. Both line numbers verified |

### Pass 0 (`§What changed from v1`)

All seven still hold at v3 and I re-checked each: the blocked-tail gate is now `line.event ===
'agent:blocked'` (spec:449, A12); A4 settles duplication as well as format; rung 3 "mirrors …
but renders through `hpipeCommand`" with `status.ts:25`'s literal handed to #14 as A13; A11 is one
source file; rung 1 is `nothing for you — this task is finished`; the totality claim is gone and
`phases.ts:145-149` is the correct span; and the §Problem evidence is now 4-of-6 divergence plus the
"76 task transitions are invisible by construction" framing, both of which reproduce.

### Compliance with the Scope ruling

Judged against the ruling's own four requirements, not against its citation:

- *"Ship the footer. Do not claim it closes the parked-task gap."* — C3 is kept (§C3) and every
  closure claim is withdrawn (spec:198-200, :630-631). I grepped for a residual: none survives.
- *Correction 1 — rewrite A10 to the measured distribution.* Partly applied; see **MINOR 1**.
- *Correction 2 — §Resolution stops claiming the acceptance sentence is met.* Applied (spec:69-91,
  :80-82). The section is an `###` rather than a `##`, but the three cross-references reach it.
- *Correction 3 — a Non-goal naming #19, and `src/lib/phases.ts` unchanged.* Applied
  (spec:204-211). Nothing in C1–C4 touches `phases.ts`; I checked the whole change set.
- *§Goal narrowed to the digest line's content, for every line the digest emits.* Applied
  (spec:192-196). The grammar at spec:308 carries task id, phase, age and action, so the design does
  deliver what the ruling says closes the issue — subject to **MAJOR 1**, which is about one rung of
  that action clause being false.
- *"Do not re-raise this through `hpipe decide`."* Honoured, and the #38 root cause the spec states
  is exact: `cmdDecide` (`src/cli.ts:218-224`) resolves the run as
  `listRuns(...).find((r) => r.tasks.some((t) => t.task_id === input.task))` with no open-run filter
  and no `--run` flag, and `listRuns` sorts filenames (`src/lib/ledger.ts:57`), so
  `…-bug-fixing-and-enhancements-qc13.json` always precedes
  `…-validate-the-silent-gates-rjms.json` in `runs/pipeline/`. Both hold a `t2`.

### What else I re-verified from source rather than from the prior passes

- **A10's distribution reproduces exactly.** `bun -e` over `run.history` up to the abort entry
  (index 78, `{"at":1789616674471,"from":"execute","to":"done","why":"aborted from execute"}`):
  79 pre-abort entries, 3 run-level / 76 task-level, span **1201.1m = 20h01m**; the two largest
  gaps are **797m** (`08:56:22.468Z → 22:13:06.395Z`) and **235m**
  (`23:49:35.584Z → 03:44:34.471Z`), combined **1032m = 85.9%**; t3's `merge` park to the abort is
  **297m = 4h57m** and the 235m window is **79%** of it. Every figure in A10 lands.
- **Occupancy.** Ten intervals in orchestrator-owned rows, **max concurrent 2**, matching spec:155-162
  line for line.
- **The ledger's divergence claim.** 4 of 6 tasks disagree at rest at my read: t2 `[done]`/`working`,
  t3 `[merge]`/`done`, t4 `[blocked-on-decision]`/`done`, t6 `[plan-review]`/`done`.
- **A3's mutator list is complete.** `grep -rn "\.phase = " src/` finds writers only at
  `src/lib/machine.ts:48`/`:93` (both followed by a `phase_entered_at` stamp at `:94`) and in
  `src/cli.ts` (a different process). `src/supervisor/ci.ts` calls neither `enterTaskPhase` nor
  `advanceTask` — it only writes `task.ci` (`:19`). So an arrow does always coincide with a 0m age.
- **The rung ladder is exhaustive over `TASK_ROWS` and correctly ordered.** 20 rows classify
  1/3/1/3/8/4. Rung 1 before rung 2 is load-bearing (`done` carries `terminal: true`,
  `src/lib/phases.ts:140`).
- **C1's blast radius.** `grep -rn "WakeLine\|applyEvents" src/ test/` finds readers only at
  `src/supervisor/main.ts:122`, `:125`, `:128`, `:212` and in `test/tick.test.ts`. Nothing reads
  `.text` outside `main.ts`.
- **C4.** `grep -rn "renderPrompt(" src/` is 19 call sites (20 hits less the definition at
  `src/lib/render.ts:40`); none names `digest`. `grep -rn digest src/` is one comment,
  `src/supervisor/deliver.ts:39`. `prompts/digest.md` is the six-line dead duplicate quoted in the
  issue. `'digest'` is on `test/prompts.test.ts:12`; the orphan assertion is `:21-24`.
- **A11's gate.** The sibling ledger gives `t1.files =
  ["src/cli.ts","prompts/intake.md","prompts/dispatch.md","README.md"]` and `t2.files =
  ["src/supervisor/tick.ts","src/supervisor/deliver.ts","prompts/digest.md"]`. `filesOverlap`
  (`src/lib/gating.ts:19-21`) finds no prefix pair against `src/supervisor/main.ts` or the three
  test files.
- **The `hpipe` hoist is possible.** `pluginRoot` is bound at `src/supervisor/main.ts:99`, outside
  the tick loop, and `hpipeCommand` is synchronous (`src/lib/render.ts:28`), so moving `:239` above
  the run loop is a pure move at identical call count.
- **The whole citation set.** `tasks.ts:17-22`/`:117-119`/`:159`/`:171-175`/`:341`,
  `machine.ts:94`, `teardown.ts:28,34`, `badges.ts:14`/`:16`, `types.ts:5`/`:71`/`:72`,
  `status.ts:12-14`/`:13`/`:21-27`/`:23-25`/`:46-62`/`:135`/`:136`, `stall.ts:70`/`:98`/`:101`/
  `:157-159`/`:161-219`/`:302`, `gating.ts:19-21`/`:19-29`/`:31-47`, `config.ts:24`/`:25`/`:28`,
  `render.ts:11`/`:19-22`/`:28-38`, `phases.ts:12`/`:72`/`:89-141`/`:105-106`/`:129`/`:130-131`/
  `:145-149`, `deliver.ts:22-31`/`:39-40`/`:50-74`/`:53`/`:62-70`/`:67`, `main.ts:122`/`:125`/`:127`/
  `:128`/`:139-142`/`:160`/`:212`/`:218`/`:219`, `smoke.md:100`/`:164-165`,
  `deliver.test.ts:33-51`/`:34`/`:47`/`:53-81`/`:121-130`/`:124`,
  `tick.test.ts:53-60`/`:62-69`, `prompts.test.ts:12`/`:21-24` — all land. So does the
  `stallAwaiting` probe block in §Rejected alternatives, reproduced from `src/supervisor/stall.ts:198-218`.

The findings below are what survived.

---

## MAJOR 1 — rung 6 ships a false sentence for `blocked-on-files`, which is the exact defect class the design is modelled on avoiding and the ground on which it rejects `stallAwaiting`

**Claim.** Rung 6 (spec:340): *"otherwise — no actor, non-terminal (`queued`, `blocked-on-files`,
`ci`, `teardown`) → `nothing for you — the supervisor is driving`"*. T9 (spec:708) pins it. The
exclusion is argued in §Non-goals (spec:217-221): *"duplicating that predicate is not worth it, and
the case is **already covered**: `blocked-on-files` is `stallable: true` with
`probeTarget: 'orchestrator'` … so the ladder nudges the orchestrator at `TASK_STALL_MINUTES`."*

**Problem.** When the task holding the overlapping files is `failed` or `escalated`, the supervisor
is *not* driving and never will be; the orchestrator is the only actor who can clear it. The digest
would then tell the orchestrator, on every tick, forever, that there is nothing for them to do about
a permanently deadlocked task. That is a sentence that is not true of what it names — the `0aa1dbf`
class the spec names as its model (spec:14-16) and the stated reason `stallAwaiting` was rejected:
*"`queued` would have shipped a false sentence — the precise failure `0aa1dbf` fixed"* (spec:811).
The design reproduces that failure one rung down, in the new component, and enshrines it in T9.

**Evidence.** `blocked-on-files` leaves only via `machine.ts:186-189`
(`if (!s.filesClear) return null`), and `filesClearFor` (`src/lib/gating.ts:49-53`) is false while any
overlapping task is `isInFlight`. Probed directly against the live table:

```
$ bun -e 'import { taskRow } from "./src/lib/phases"; …'
failed               holdsFiles=true  terminal=true       actor=undefined stallable=undefined
escalated            holdsFiles=true  terminal=undefined  actor=human     stallable=undefined
```

`isInFlight` (`src/lib/gating.ts:23-28`) returns `rule === true` for both, so a `failed` or
`escalated` holder blocks forever. The repo already treats this as a human move:
`src/lib/status.ts:55-60` computes `const stuck = taskRow(holder.phase).terminal || holder.phase ===
'escalated'` and prints `` `hpipe release --task <holder>` is the only way out ``.

Both halves of the Non-goal's rebuttal also fail:

- *"duplicating that predicate is not worth it"* — **nothing needs duplicating.** `filesOverlap`,
  `isInFlight` and `filesClearFor` are all `export`ed from `src/lib/gating.ts` (`:19`, `:23`, `:49`),
  and `src/supervisor/tick.ts:1-4` already imports from `../lib/decisions`, `../lib/machine` and
  `../lib/phases`. `gating.ts` imports only `./phases` and `./types`, so no cycle.
- *"already covered … the ladder nudges the orchestrator"* — the nudge fires at
  `TASK_STALL_MINUTES = 45` (`src/lib/config.ts:28`), and `files` is **not** in `ESCALATING_SIGNALS`
  (`src/supervisor/stall.ts:22` — `{'artifact','verdict','pr'}`), so the row is probed up to
  `STALL_PROBE_MAX` and then goes quiet permanently without escalating. The probe's own sentence
  (`stall.ts:198-202`) is *"waiting for another task to release the files this one declared"* — which
  never names the escape hatch either. So for the first 45 minutes the digest actively contradicts
  the truth, and after the ladder exhausts itself the digest is the only thing still speaking, and it
  is still wrong.

**Concrete fix.** Either is inline and neither needs a new file:

1. **Cheapest, no new import.** Split `blocked-on-files` out of rung 6 with a clause that is true in
   both cases — e.g. `waiting on another task's files`. This satisfies truthfulness but leaves the
   deadlock case without an action, which is a knowing shortfall against the ruling's *"what the
   orchestrator is expected to do"* bar and should be said in the Non-goal rather than left implied.
2. **Preferred, and the one the ruling's bar actually asks for.** Import `isInFlight`/`filesOverlap`
   from `src/lib/gating.ts` into `tick.ts` and render, for a stuck holder,
   `` YOUR move: `<hpipe> release --task <holder>` ``, mirroring `status.ts:55-60` the same way rung 3
   mirrors `status.ts:23-25`. Note this **amends** the §Non-goals bullet at spec:217-221 rather than
   satisfying it, so say so there. Add a T-case for each branch (healthy holder → supervisor-driving
   clause; `failed`/`escalated` holder → the release clause) and extend the exhaustiveness guard,
   which currently asserts every row maps to *one of six known clauses* and would have to admit a
   seventh.

---

## MAJOR 2 — the footer is attached to only one of the three orchestrator-pane pendings, so a digest produced by a task prompt or a run-phase prompt alone is delivered without it

**Claim.** Flow step 10 (spec:476-479): *"`addPending(run.orchestrator_pane, nextPrompt, lines, …)`
additionally carries `footer: parkedFooter(run, covered, tickNow, hpipe)`."* A10 (spec:602-606): *"The
footer never causes a delivery; it only decorates one."* §Error handling tables exactly one
suppression case (spec:519): *"A footer would be the digest's only content → no digest is sent."*

**Problem.** `run.orchestrator_pane` receives **three** `addPending` calls per run, not one:

```
src/supervisor/main.ts:213   addPending(run.orchestrator_pane, nextPrompt, lines, `run phase${phaseNote}`, phaseNote)
src/supervisor/main.ts:215   addPending(prompt.paneId, prompt.text, [], `task ${prompt.taskId}`)      // ← orchestrator for non-worker rows
src/supervisor/main.ts:217   addPending(run.orchestrator_pane, enteredRunPhase, [], `run phase ${run.phase}`)
```

`:215` routes to the orchestrator pane for every non-worker row, because `actorPane`
(`src/supervisor/tasks.ts:117-119`) returns `run.orchestrator_pane` whenever
`taskRow(task.phase).actor !== 'worker'` — i.e. for `merge`, `close`, `blocked-on-decision`, `ci`,
`teardown`, `queued`. `addPending` then sets `isOrchestrator: paneId === run.orchestrator_pane`
(`:167`), so `deliveriesFor` wraps it in a full digest (`src/supervisor/deliver.ts:64-69`).

So when `nextPrompt` is empty and `wake` has no line for this run, `:213` returns at `:160` and the
footer is discarded — **but `:215` or `:217` can still produce a delivered digest**, because
`deliveriesFor` picks the footer with `group.find((p) => p.footer)` and the only pending that carried
one was never pushed. A digest goes out; the parked task is not in it. That is a second suppression
case, and the spec tables neither it nor its cost.

**Evidence that it is not hypothetical, on the run C3 is built around.** A task can advance into an
orchestrator-owned row with **no** herdr pane event at all: `ciTransitions`
(`src/supervisor/main.ts:139-142`) writes only `task.ci` (`src/supervisor/ci.ts:19`), and the
`ci → merge` transition is then taken by `advanceTasks` off `ciBucket`, not off a wake line. t3's own
entry into `merge` is exactly that shape:

```
t3  2026-09-16T22:47:13.655Z  pr-review-quality -> ci
t3  2026-09-16T22:47:27.752Z  ci                -> merge      (14s later; the CI poll, not a pane event)
```

On that tick `promptForTaskPhase` renders `prompts/merge.md` to the orchestrator pane
(`src/supervisor/tasks.ts:74`, `:175`), `:215` pushes it, and a digest is delivered. If `wake` held
nothing for the run that tick, C3 as specified contributes nothing to it — and the tick a task enters
`merge` is precisely the tick on which *another* parked task most wants to be named.

**Concrete fix.** Compute the footer once per run and attach it to every orchestrator-pane
`addPending` — add a `footer?: string` parameter to `addPending` and pass it at `:213`, `:215` (when
`prompt.paneId === run.orchestrator_pane`) and `:217`; `deliveriesFor`'s `group.find((p) => p.footer)`
already de-duplicates, so the footer still renders once. Note that `covered` must still be built by
step 9 first. Then correct A10 and the §Error handling row to say that the footer rides *any*
orchestrator delivery, not only the wake-line one, and add a T-case: an orchestrator pending with an
empty `text`/`events` plus a second orchestrator pending carrying only a task prompt still renders the
footer.

---

## MINOR 1 — the ruling's correction 1 is only two-thirds applied, and the disposition row says "in full"

The Scope ruling's first required correction is explicit about *where*: *"Rewrite **A10** to the
measured distribution … and state that the footer's new coverage is `merge` (plus `escalated` if
MAJOR 2 is taken) because `blocked-on-decision` is already on the stall ladder."* A10 (spec:602-633)
carries the distribution and the t3 overlap, but the new-coverage sentence is not there — it is in
**A9** (spec:593-597), with no cross-reference in either direction. The disposition row at spec:48
nevertheless reads *"**Accepted in full, per the ruling.** … **A10** rewritten to the measured
distribution"*. The substance is in the document, so this is a fidelity defect, not a gap; but a
fourth pass auditing the ruling clause by clause will not find it where the ruling put it.

**Fix.** Add one sentence to A10: *"Of the rows the footer covers, the genuinely new coverage is
`merge` and `escalated` (**A9**, **A16**) — `blocked-on-decision` is already `stallable`
(`src/lib/phases.ts:129`) and probed by `taskStallCandidates` (`src/supervisor/stall.ts:101`), and
`close` measured at 0/0/1/2m."*

## MINOR 2 — A12 states the dead-pane caveat but not that the tail is the pane's *current* screen

A12 (spec:649-656) is right that the new gate fires per line rather than per task, and right that
*"a pane that died between event and delivery yields an empty read"*. What it does not say is that
`herdr.paneRead` at `src/supervisor/main.ts:126` reads the pane **now**, after every event in the
drain has been applied. In the very ordering the spec uses to justify the fix — `blocked` then `idle`
in one drain (spec:283-287) — the tail attached to the `agent:blocked` line is therefore a screen
scraped *after* the block cleared. Today that ordering attaches no tail at all, so the fix trades a
missing tail for a mislabelled one. It is still the right trade (the reverse ordering is strictly
worse today, and `TICK_MS` is 1000ms so the window is small), but A2 calls the tail *"the most
actionable text in any digest"*, and a reader who trusts that label deserves the caveat.

**Fix.** Extend A12's last sentence: *"…and the read is of the pane's current screen, so on a
`blocked → idle` drain the `agent:blocked` line carries the pane as it looks once the block has
cleared. Bounded by one tick; the alternative is no tail at all, which is today's behaviour."*

## MINOR 3 — §Testing's wake-producing test enumeration is five, not four

§Testing (spec:751-755): *"the four wake-producing tests at `:71`, `:80`, `:98`, `:114` discard
`applyEvents`' return value."* `test/tick.test.ts:34-42` (*"an agent_status event updates the matching
task"*) also produces a wake line — it passes `agent_status: 'idle'` and lets `wakeOn` default to
`new Set(['blocked','done','idle'])` (`src/supervisor/tick.ts:27`), so `tick.ts:86-91` pushes. It
destructures `const { changed } = applyEvents(…)` at `:39`, so the **conclusion is unaffected** and
the blast-radius claim still holds. Both prior passes re-asserted the same count; this is the third
document to carry it.

**Fix.** *"the five wake-producing tests at `:34`, `:71`, `:80`, `:98`, `:114`."*

## MINOR 4 — the inline finding tags collide across the two passes

v3 carries two disposition tables with independent numbering, and the inline tags in the body do not
say which pass they belong to. `**[MAJOR 1]**` means pass 0's blocked-tail finding at spec:278 and
pass 1's optional-`footer` finding at spec:417. `**[MINOR 4]**` means pass 0's rung-1 finding at
spec:342 and pass 1's `main.ts:160` finding at spec:519 and spec:605. `**[MINOR 3]**` is used twice
in one paragraph (spec:635, :641) for what are in fact pass 0's and pass 1's findings. The document
already knows the fix: it writes `**[pass 0 MAJOR 1]**` at spec:649 and `**[pass 1 MAJOR 1]**` at
spec:667 and `:757`.

**Fix.** Qualify every remaining bare tag with its pass, as spec:649/:667/:675/:757 already do.

## MINOR 5 — the footer's join is underspecified, and T23 pins only the empty case

§C3 renders the footer with a leading blank line (spec:379-384) and says *"`buildDigest` appends it
after `nextPrompt`"* (spec:428). `buildDigest` is `[header, '', count, ...lines, '', nextPrompt]
.join('\n').trimEnd()` (`src/supervisor/deliver.ts:23-30`). An implementer following both literally
gets one blank line before the footer when `nextPrompt` is non-empty and **three** when it is empty —
which is the common case, since `nextPrompt` is `''` unless a run-level phase was entered. T23
(spec:735) asserts *"no stray blank lines"* only for `footer: ''`, where `.trimEnd()` already handles
it; the case that can actually produce them is untested.

**Fix.** Specify the footer as carrying no leading newline of its own and being appended as a
separate array element after `nextPrompt`, with `buildDigest` filtering empty trailing slots — or
state the exact joined shape. Extend T23 to assert exactly one blank line before
`also waiting on you:` with `nextPrompt: ''`.

---

Nothing above asks for C3 to be dropped, for the Scope ruling to be revisited, or for a file outside
the declared set beyond the `src/supervisor/main.ts` A11 already declares. MAJOR 1's preferred fix
amends one §Non-goals bullet, which is the spec author's call to make on the evidence, not the
human's — but if it is taken, say so in that bullet rather than leaving the bullet standing against
the change.

VERDICT: CLEAR
