# Adversarial spec review — issue #15, pass 1 (narrowed scope)

Target: `docs/superpowers/specs/2026-09-17-issue-15-design.md`, the revision committed as `002c127`,
reviewed against `gh issue view 15` (including the **Scope narrowed — 2026-09-17** ruling),
`docs/superpowers/research/2026-09-17-issue-15-research.md`, and
`docs/superpowers/reviews/issue-15-spec-review-0.md` (VERDICT: BLOCKER — 1 BLOCKER / 3 MAJORs /
5 MINORs).

Baseline re-verified independently in this worktree:

```
$ bun test          → 351 pass, 0 fail, 767 expect() calls, 33 files
$ bun run typecheck → tsc --noEmit, clean
```

spec:13 and spec:525 are accurate.

**Removed features stay removed.** `grep -n "livePanes\|paneList\|DeliveryBudget\|accepts\|A11\|A12\|A14\|A17\|A19\|A23\|A24"`
over the spec hits only the disposition table, the Scope "Out, moved" line (spec:43-47), the
`*Deleted:*` line (spec:164) and the *Superseded premises* section. Dead-pane detection appears only
as **NG4 → #24** (spec:133) and `DeliveryBudget` only as **NG5 → #25**. Nothing removed is quietly
retained, and no finding below asks for either back.

---

## What I re-verified from the pass-0 dispositions

Every row of the "What changed" table (spec:19-29), checked against the code rather than the prose:

- **BLOCKER 1 → A26 is correct, and the asymmetry is correct too.** `releasesPane: true` is on
  exactly two run rows, `escalated` (`phases.ts:70-71`) and `done` (`phases.ts:72`), so one predicate
  covers abort, completion and escalation, and `pickOneAdvance` uses the identical test
  (`tick.ts:109`). The spec's claim that `stallCandidates` needs no guard (spec:251-255) holds:
  executing the filter gives stallable run rows = `dispatch`, `execute`, `branch-review`
  (`phases.ts:55`, `:57`, `:66`) — `escalated` and `done` are not stallable, so the run level cannot
  produce a candidate for them. Choosing `releasesPane` over `terminal` is right for the stated
  reason (`escalated` is `releasesPane` and not `terminal`, `phases.ts:71`). A26 also silently
  protects something the spec does not claim: `cmdResume` refuses unless `run.history.at(-1).why`
  still starts with `aborted from` (`cli.ts:308-311`), and a ladder escalation inside an aborted run
  would have pushed a history entry (`machine.ts:91`) and broken `resume` outright.
- **MAJOR 2 → A13 genuinely fixes the sentence, not just the value.** The old template asserts the
  shape twice — `prompts/stall-probe.md:3` ("nothing has appeared at:") and `:9-10` ("move it to the
  path above") — and the rewrite at spec:344-352 contains neither, with `stallAwaiting` returning the
  whole clause (spec:325). The regression tests at spec:550-551 and spec:574-576 pin it. The A13
  table (spec:329-339) covers every signal reachable from a stallable row: run `worktree`/`gate`/
  `verdict` (`phases.ts:54`, `:56`, `:64`) and task `artifact`/`verdict`/`files`/`pr`/`manual`
  (`phases.ts:92-129`).
- **MAJOR 3 → A27's arithmetic is exact.** With the due rule at spec:439, probe *k* falls at
  *k* × threshold and a hold consumes a slot, so at `TASK_STALL_MINUTES: 45` (`config.ts:27`)
  escalation is at 4 × 45 = **180m**, and 7 × 45 = **315m** with three holds; at
  `STALL_MINUTES: 15` (`config.ts:26`), **60m** and **105m**. Both match spec:271-274. The uncited
  "a rate-limited agent does not report `working`" claim is gone — `grep -n "rate.limit\|usage limit"`
  over the spec returns nothing — and NG1 now rests on the bound alone (spec:276-280), which is a
  true argument. `actorPaneFor` (spec:286-288) is right: `Herdr.agentStatus` returns `'unknown'` on
  failure (`herdr.ts:68-71`), and `!== 'working'` rather than `isAgentReady` (`machine.ts:30-32`)
  correctly keeps `blocked` escalatable.
- **MAJOR 4 → basis corrected, and the ledger confirms the underlying fact.** The live ledger today:
  ```
  $ …/runs/pipeline/herdr-plugin-pipeline-20260917-bug-fixing-and-enhancements-qc13.json
  run … execute
    t1 fix/9-artifact-paths  #9  plan-review  working  ['src/cli.ts','src/lib/worker-prompt.ts',
                                                        'src/supervisor/tasks.ts','src/supervisor/deliver.ts',
                                                        'prompts/worker-brief.md']
    t2 fix/15-stall-escalation #15 spec-review working ['src/supervisor/stall.ts','src/supervisor/main.ts',
                                                        'prompts/stall-probe.md','src/lib/status.ts']
  ```
  `src/cli.ts` is t1's, as the corrected basis at spec:51-55 now says. The ruling's "unheld" list —
  `types.ts`, `machine.ts`, `test/cli-commands.test.ts` — is confirmed clean against both tasks'
  `files`. The Files table (spec:67-76) and the "Never edited" list (spec:78-82) are accurate;
  `config.ts` and every named test file appear in neither task's declaration.
- **A28's writer enumeration is exhaustive.** `grep -rn "phase_entered_at = " src/` returns exactly
  the five sites at spec:208-212: `cli.ts:180`, `cli.ts:186`, `cli.ts:317`, `machine.ts:49`,
  `machine.ts:94`, plus the two creation literals (`cli.ts:85`, `ledger.ts:32`) the spec calls out at
  spec:214-215. `enterRunPhase`/`enterTaskPhase` do restamp with `Date.now()` (`machine.ts:49`,
  `:94`), so the self-invalidation mechanism works where it applies.
- **MINORs 5-8 are all genuinely applied.** A22's rewording (spec:485-488) scopes "unconditional" to
  the send. Both loop `saveRun` sites are named (spec:490-494) and `main.ts:136` / `main.ts:217` are
  what the spec says they are. `branch-review` really does lack `stallWhen` (`phases.ts:64-66`;
  `execute` is the only run row that has one, `phases.ts:58-59`), and spec:312-314 now says the more
  useful true thing. A15 now covers runs as well as tasks (spec:200-211), and `status.ts:104-109` is
  indeed the schema warning it sits beside.
- **A21's literal arrays are executably correct.** Filtering `TASK_ROWS` and `RUN_ROWS` by
  `stallable` against `phases.ts:89-141` and `:51-73` reproduces spec:560-566 row for row (ten task
  rows, three run rows), and A18's nine escalating / four probe-only split (spec:304-306) reproduces
  exactly under `signal ∈ {artifact,verdict,pr}`.
- **`test/stall.test.ts` numbers are exact.** `grep -c "test("` → `20`; `grep -c "new Set("` → `18`;
  `test/stall.test.ts:147-151` is the paneless-worker routing test and `:165-175` is the
  null-pane-not-marked-probed test, as spec:540-541 and spec:515 claim.
- **`prompts.test.ts` hooks are where the spec says.** `ALL` at `:10-14`, the orphan test at
  `:21-24`, the no-literal-`hpipe` test at `:68-76`. `render` really does throw on an unresolved
  placeholder (`render.ts:11`) and `renderPrompt` really does inject `hpipe` into the bag
  (`render.ts:46`) with a function replacement whose output is never re-scanned — so spec:358-363's
  argument for passing `hpipe` in as a value is correct.

Two things the revision did not get right are below. The first is a new failure mode the ladder
introduces that no pass has examined; the second is a claim in the BLOCKER-1 fix that the code
contradicts.

---

## BLOCKER 1 — the due rule is anchored to `phase_entered_at` alone, so any record first observed past its threshold fast-forwards the whole ladder at tick speed: a burst of back-to-back probes one second apart, and escalation before the actor has ever had a threshold-length window to answer

**Claim.** spec:439, the due rule: *"**Due:** `now - phase_entered_at >= threshold × (probes + holds + 1)`
minutes."* spec:143 (**A2**): *"Constant probe interval, not exponential backoff."* spec:531, the first
new unit test: *"probe 1 due at exactly `threshold`; probe 2 at `2 × threshold`, not `threshold + 1m`."*
The whole design rests on the ladder giving an actor `threshold` minutes to respond between rungs.

**Problem.** The rule compares an *absolute* age against a *count*, and nothing records when the last
rung was actually climbed. `applyStalls` (spec:452-473) takes one action per candidate per tick, and a
tick is `TICK_MS: 1000` (`config.ts:23`, `main.ts:272`). So for a record whose age at first observation
is `A`, the predicate is already true for probes = 0, 1, 2, … up to `floor(A / threshold) - 1`, and the
supervisor climbs one rung **per tick** until the count catches up with the clock.

That is not an edge case. It is the state of every record on:

1. **Supervisor restart**, which `test/integration/smoke.md:479` documents as a routine recovery —
   *"The supervisor died | … Reopen with `herdr plugin action invoke stein.pipeline.supervisor`.
   Nothing advances until it is back; no state is lost."* Today the probe set is a bare in-memory
   `Set` created per process (`main.ts:109`), so a restart costs exactly one probe per record. **A4**
   persists the counter but nothing re-anchors the schedule, so the restart now costs a burst.
2. **First deployment of the ladder** onto a session with live runs — every stallable record older
   than its threshold bursts on the supervisor's first tick.
3. A task that entered its phase while the supervisor was down, and a run that re-enters
   `REPOS_ALLOW` (`main.ts:115-118`).

Worked through at the shipped defaults, against the very incident in the issue (13 h = 780 min,
`TASK_STALL_MINUTES: 45`):

- **An A18-eligible row** — say `implement` (`phases.ts:109-110`, `signal: 'pr'`). Tick 1: due
  (780 ≥ 45), probe, `probes = 1`. Tick 2, one second later: due (780 ≥ 90), probe, `probes = 2`.
  Tick 3: probe, `probes = 3`. Tick 4: `probes >= probeMax`, **escalate**. Three prompts and an
  `escalated` transition in four seconds. The worker is moved into `TERMINAL_BAD` (`gating.ts:6-8`),
  cascading every dependent to `blocked-on-failure` (`gating.ts:34-38`), without ever having been
  given the 45 minutes the ladder exists to give it. And **A25**'s text (spec:334-336) is delivered
  as a lie: *"This is probe 2 of 3. After 3 unanswered probes this phase is escalated"* arrives one
  second after probe 1.
- **An A18-excluded row is worse, because the count is unbounded.** Step 6 (spec:440) makes the
  action `probe` — never `escalate` — for `blocked-on-decision` and `blocked-on-files`, so the
  counter keeps climbing. A task sitting in `blocked-on-decision` for 13 hours — *waiting correctly,
  on a human, which is exactly why A18 excludes it* — is due for probes 1 through 17
  (`floor(780/45) = 17`) and receives **seventeen "Still working?" prompts in seventeen seconds**,
  into `run.orchestrator_pane` (`phases.ts:126-127` has no `probeTarget`, so `probePaneFor` returns
  the orchestrator, `stall.ts:22-26`). Today it receives exactly one, ever. Probes are sent straight
  through `herdr.agentPrompt` in the stall block (`main.ts:250`, `:266`), not through
  `deliveriesFor`'s per-pane coalescing (`deliver.ts:50-57`), so each one is a separate prompt.

The spec's own unit test hides this. spec:531 constructs the *continuous* case, where the supervisor
observed every threshold crossing; under that construction probe *k* does land at *k* × threshold and
the test passes. **A2**'s "constant probe interval" is true only under that same assumption, and
nothing in the spec states it. This is the repo's documented failure pattern — spec:580-581 says
*"DI with fakes hid a wiring bug in this repo before"* — reproduced one layer up: the test asserts the
property in the only scenario where it holds.

Finally, the live-verification section cannot catch it either. All six steps (spec:584-594) start
from a freshly-entered phase with the supervisor already running.

**Fix.** Anchor the schedule to the last rung, not to the phase entry. Extend **A28**'s field and
accessor — both are new in this change, so this costs nothing:

```ts
stall?: { at: number; last: number; probes: number; holds: number }
```

with `last` stamped by `bumpStall` on every probe and every hold, and the due rule becoming

```
const { last } = stallCountsFor(record)        // falls back to phase_entered_at when stale/absent
due = now - last >= threshold
```

In the continuous case this is *identical* to spec:439 — probe *k* still lands at *k* × threshold, so
**A2** and the spec:531 test are preserved unchanged — but a record first observed at any age gets one
probe, then one per threshold, never a burst. Then:

- Add the unit test the current design cannot pass: *a record first observed at 10 × threshold yields
  one candidate on the first tick and none on the next*, and *an A18-excluded row observed at
  10 × threshold is probed once, not ten times*.
- Add a live-verification step: start the supervisor against a ledger whose task has been in
  `implement` for ≫ `TASK_STALL_MINUTES` and confirm exactly one probe on the first tick.
- State the trade explicitly in the assumption table, because it is a real one and it is the
  orchestrator's to make: under this fix a task that stalled for 13 hours while the supervisor was
  down takes a further `probeMax × threshold` to escalate after the restart, rather than escalating
  four seconds in. The alternative — clamping `phase_entered_at` forward to first observation — has
  the same effect and the same cost; either is defensible, but the spec must choose one and say why.

---

## MAJOR 2 — A26 stops the probes during an abort but nothing re-arms a **task**'s ladder on `hpipe resume`, so the spec's own acceptance criterion for the BLOCKER-1 fix is false, and the first tick after `resume` escalates the task the human just recovered

**Claim.** spec:591-592, live-verification step 5: *"**`hpipe abort` a run with a live task, wait past
the cap: no probe, no escalation. `hpipe resume` and confirm the ladder re-arms from zero** (**A26**,
**A28**)."* spec:544-546 repeats it as a unit assertion: *"a record whose `stall.at` is stale reads
zero; re-stamping `phase_entered_at` by the `enterTaskPhase`/`cmdRewind`/`cmdResume` mutation each
re-arms the ladder."*

**Problem.** `cmdResume` never touches a task. The whole function is `cli.ts:304-320`, and its only
mutations are `run.phase` (`:315`), `run.escalated_from` (`:316`) and `run.phase_entered_at` (`:317`);
it does not walk `run.tasks`. `cmdAbort` is the same — it sets `run.escalated_from` and
`run.phase = 'done'` and nothing else (`cli.ts:292-302`), deliberately: *"Worktrees and branches are
untouched"* (`cli.ts:296`).

So across an abort/resume cycle a task's `phase_entered_at` is **unchanged**, and therefore
`stall.at === task.phase_entered_at` still holds and `stallCountsFor` (spec:197-201) returns the
**pre-abort counts**, not zero. A28's stated claim at spec:204-205 — "all five `phase_entered_at`
writers are covered" — is true, but the inference drawn from it in step 5 is not, because abort and
resume are not `phase_entered_at` writes *on the task*. Step 5 as written cannot pass.

The consequence is the pass-0 BLOCKER's own failure mode, moved from during-the-abort to
at-the-resume. A human aborts a run with a task at `probes = 3` in `implement`, comes back four hours
later and runs `hpipe resume`. On the very next tick the task is due (four hours ≫ any threshold —
and under BLOCKER 1 above it is due regardless), `probes >= probeMax`, so it goes straight to
`escalated` with no probe at all. `smoke.md:477` promises `resume` *"puts it back where it was"*.
It does not.

The clean fix is blocked by scope, which is why this needs a ruling rather than an inline edit:
resetting the counters in `cmdResume` means editing `src/cli.ts`, and the ruling's permission is
`cmdRewind` **only** ("the unheld `src/cli.ts` (`cmdRewind` only)"), on a file the live ledger shows
is t1's.

**Fix.** Do it inside the held files, by making a task's ladder depend on the run's phase entry as
well as its own — which is a one-line extension of the accessor **A28** is already introducing:

```ts
stall?: { at: number; run_at: number; last: number; probes: number; holds: number }

export function stallCountsFor(run: Run, r: Run | Task) {
  return r.stall?.at === r.phase_entered_at && r.stall.run_at === run.phase_entered_at
    ? { probes: r.stall.probes, holds: r.stall.holds, last: r.stall.last }
    : { probes: 0, holds: 0, last: r.phase_entered_at }
}
```

`cmdResume` already restamps `run.phase_entered_at` (`cli.ts:317`), and so does a run-level
`cmdRewind` (`cli.ts:186`) and `enterRunPhase` (`machine.ts:49`) — so every task ladder in the run
re-arms from zero with **no CLI file touched**, keeping **A28**'s "no reset site is edited" property
intact and extending it to the case it currently misses. Then correct step 5 to assert what will
actually be true, and add the unit test the current spec claims but cannot deliver: *a task whose run
is put through `cmdAbort`'s exact mutation and then `cmdResume`'s exact mutation reads `probes: 0`*.
If the orchestrator would rather take the literal enumeration route, that is the `cmdResume` edit the
*Open decisions* section already offers to escalate — but note that the ruling's permission as
written does not cover `cmdResume`.

---

## MINOR 3 — `applyStalls` reads `deps.probeMax`, which `StallDeps` does not declare

spec:465 gates the deferral on `holds < deps.probeMax`, but the interface eleven lines above
(spec:445-450) declares only `probe`, `escalate`, `agentStatus` and `persist`. This is churn damage:
the cap is the **A27** fix for pass-0's MAJOR 3 and was added to the body without the interface.
`probeMax` is otherwise a *classification*-time parameter (`stallCandidates(runs, now, threshold,
probeMax)`, spec:430-431), so it is genuinely not in scope in `applyStalls` today. Add
`probeMax: number` to `StallDeps`, or carry the already-computed `holdsRemaining` on `StallCandidate`
beside `escalatable` (spec:424) and keep the deps free of configuration. `tsc --noEmit` would have
caught this in code; it did not, because it is prose.

## MINOR 4 — `prompts/stall-escalate.md` is specified around a variable that is never defined, and the variable it most likely means cannot be substituted there

The MINOR 9 fix (spec:373-398) gives the prompt a body, which is the right call — but spec:381 reads
*"This phase went `{{probes}}` stall probes without producing `{{awaiting_short}}`"*, and
`awaiting_short` appears nowhere else in the spec. The only thing that could supply it is
`stallAwaiting` (spec:325), and that returns "**the whole clause**" by **A13** — for the `artifact`
row, a three-paragraph string beginning `Nothing has appeared at:` (spec:331). Substituted into
spec:381 it is ungrammatical, and `render` throws on the placeholder if the bag omits it
(`render.ts:11`), so the prompt cannot ship unspecified. State the bag in full — `run_id`, `phase`,
`minutes`, `probes`, `task_flag`, `awaiting_short` — and give `awaiting_short` its own accessor
returning the bare object (`a pushed PR for <branch> (#<issue>)`, `the research artifact at <path>`),
which is the thing **A13** deliberately stopped returning. Also pin `task_flag` to the existing
convention: `` ` --task ${task.task_id}` `` for a task and `''` for a run (`tasks.ts:84`,
`escalate.md:15`).

## MINOR 5 — `bumpStall` is used twice and never defined, and neither it nor `stallCountsFor` is given a file

`bumpStall(record, 'probes')` (spec:458) and `bumpStall(record, 'holds')` (spec:467) carry the entire
persistence mechanism and appear nowhere else in the spec. `stallCountsFor` is shown at spec:197-201
under a comment that names `types.ts` only for the *field* (spec:189), and `src/lib/types.ts` is
today a pure declaration module — 127 lines, no runtime export — so putting a function there would be
a first for that file and worth stating deliberately rather than by omission. The referenced
`StallState` type (spec:197) is never declared either; the field is written inline at spec:193. Name
the home for all three (`stall.ts` is the natural one, and is held by t2) and give `bumpStall` its
three lines, including the `at:` stamp that spec:204 says every bump writes.

## MINOR 6 — `escalated_from` is overloaded by `cmdAbort`, and A15's predicate is left unstated

**A15** (spec:200-211) says the new run-level warning *"Uses `ageMinutes` (`status.ts:12-14`),
`escalated_from` (`types.ts:57`, `:95`)"* and *"Fires for every escalated record"* — both citations
check out — but does not say what it keys on. `run.escalated_from` is not exclusive to escalation:
`cmdAbort` stores the pre-abort phase in the same field (`cli.ts:298`) and leaves it set until
`cmdResume` clears it (`cli.ts:316`). An implementer keying on `escalated_from !== null` will print
`⚠ run … escalated from execute — needs a human` for every **aborted** run in `hpipe status`, which is
both wrong and directly contrary to the abort/resume contract **A26** was added to protect. Say
`run.phase === 'escalated'` explicitly, and assert the negative in `test/status.test.ts`: an aborted
run produces no escalation warning.

## MINOR 7 — a citation regressed in this revision

spec:612 cites *"a delivery is only attempted when the tick produced text (`main.ts:159`,
`deliver.ts:51`)"*. `deliver.ts:51` is `const byPane = new Map<string, PendingPrompt[]>()`; the
emptiness check is `deliver.ts:53` — `if (p.text.length === 0 && p.events.length === 0) continue` —
which is what pass 0 cited and verified. `main.ts:159` is correct. Restore `:53`.

---

## What is right, and should survive

Checked against the code, not restated from the spec:

- **A26 is the correct guard, correctly scoped**, and the decision to leave `stallCandidates`
  unguarded is justified rather than overlooked — with a test pinning the asymmetry (spec:535-536).
- **A18's narrowing is sound and fully verified**, including the reasons for excluding
  `blocked-on-files` (clears only when a sibling releases, `machine.ts:186-189`) and
  `blocked-on-decision` (waits on a human, `phases.ts:126-129`), and the observation that excluded
  rows lose nothing human-visible (`status.ts:21-26`, `:38-55`).
- **A13/A25's "compose the clause at the call site"** is the right shape, and the reasoning for
  passing `hpipe` in as a rendered value rather than a placeholder (spec:358-363) is exactly right
  about `render.ts:8-14` and about why `test/prompts.test.ts:68-76` cannot catch the alternative.
- **A27's bound is the right answer to pass-0's MAJOR 3**, reusing `STALL_PROBE_MAX` rather than
  adding a knob, and the withdrawal of the uncited empirical claim is the honest move.
- **A28's self-invalidation is a better mechanism than the literal enumeration** for the four writers
  it does cover, for the reason given (spec:222-226): the enumeration has already gone stale once.
  Flagging the deviation under *Open decisions* rather than burying it is correct. MAJOR 2 is a gap
  in its *coverage*, not an argument against the mechanism.
- **A21 is the right guard for NG2**, and the reason `table.test.ts:30-37` is insufficient is exact.
- **The superseded-premises section is correct and worth keeping.** 13 h at `TICK_MS: 1000` is
  ≈46,800 ticks, not 33; 33 over 780 minutes is ~1 per 24 minutes; `main.ts:234` really does delete
  the per-pane counter in the give-up branch. Saying the research note is wrong, in the note's own
  terms, is the right call.
- **The Pre-PR gate and the ledger-quoted Files table** are the right response to the holdings
  question, and the "import, never edit" line for `deliver.ts` (spec:78-82) is honoured by every
  other section.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 1
