# Adversarial spec review — issue #15, pass 0 (narrowed scope)

Target: `docs/superpowers/specs/2026-09-17-issue-15-design.md` (labelled "Pass 2"), reviewed against
`gh issue view 15` including the **Scope narrowed — 2026-09-17** ruling, and
`docs/superpowers/research/2026-09-17-issue-15-research.md`.

Numbered pass 0 because the ruling reset the scope: dead/unreachable pane detection is now **#24**
and `DeliveryBudget` is **#25**. I verified both issues exist (`gh issue view 24` → "Stop delivering
into a pane that cannot answer, without freezing the run"; `gh issue view 25` → "Bound the
supervisor's send paths with a delivery budget"), and I grepped the spec for residue of the removed
features — `livePanes`, `paneList`, `DeliveryBudget`, `accepts`, A11/A12/A14/A17/A19 appear only in
the disposition table, the Scope "out of scope" line, and the `*Deleted:*` line. **Nothing removed
is quietly retained.** No finding below asks for #24 or #25 back.

Baseline re-verified independently in this worktree:

```
$ bun test    → 351 pass, 0 fail, 767 expect() calls, 33 files
$ bun run typecheck → tsc --noEmit, clean
```

The spec's claim at spec:13 is accurate.

---

## What I re-verified from the pass-1 dispositions

The "What changed from pass 1" table (spec:19-31) claims a disposition for each surviving finding. I
checked every one that is not simply moot:

- **MAJOR 6 (`cmdResume`) — genuinely fixed and now verifiable.** `grep -rn "phase_entered_at = " src/`
  returns exactly the five sites the spec prints at spec:317-320: `cli.ts:180`, `cli.ts:186`,
  `cli.ts:317`, `machine.ts:49`, `machine.ts:94`. The enumeration is exhaustive as claimed. The
  restated failure mode is correct: `cmdAbort` stores `run.escalated_from = run.phase` (`cli.ts:298`),
  `cmdResume` restores it and restamps `phase_entered_at` (`cli.ts:313-317`) touching no counter, and
  run `escalated` is `releasesPane: true` (`phases.ts:70-71`) so `pickOneAdvance` skips it
  (`tick.ts:109`).
- **MINOR 11 — all three fixed.** `main.ts:113` is `drain(queueDir)` and `main.ts:114` is
  `listRuns`; the spec cites `:114`. The Files table (spec:63-75) now names `config.ts`,
  `stall-escalate.md` and `phases.test.ts`. The research note is marked superseded at spec:8-11.
- **MINOR 10 — fixed correctly.** `worktree` is the signal of run `dispatch` (`phases.ts:54`) **and**
  task `teardown` (`phases.ts:124`); the table splits them (spec:269-270) and the contradicting
  sentence is gone.
- **A18's set is executably correct.** Filtering `TASK_ROWS`/`RUN_ROWS` by `stallable` and by
  `signal ∈ {artifact,verdict,pr}` against `phases.ts:89-141` and `:51-73` reproduces spec:203-205
  exactly: nine escalating rows, four probe-only. A21's literal arrays (spec:481-489) match
  `phases.ts` row for row.
- **A5's diff-honesty numbers are exact.** `grep -rl "delivery_attempts: 0" test/ | wc -l` → `11`;
  `grep -rn … | wc -l` → `13`.
- **P3b is correctly diagnosed.** `artifactPathFor(run, null)` cannot return null — it falls through
  to `join('docs/superpowers/reviews', …)` at `deliver.ts:92-93` — so `main.ts:247`'s
  `?? 'the expected artifact'` is dead code, and `dispatch`/`execute` probes today name an invented
  review path. The `verdict`-row fix is also right: `promptForRunPhase` computes `verdict_path` from
  the same `absoluteArtifactPath(run, null)` (`deliver.ts:168`), so a `branch-review` probe will name
  the exact path the orchestrator was told to write.
- **The A4 persistence argument holds.** `listRuns` `readJson`s each file fresh every tick
  (`ledger.ts:48-62`), `saveRun` serialises the whole `Run` including `tasks` (`ledger.ts:44-46`),
  and the candidate's `task` is the same object inside `c.run.tasks` (`stall.ts:71-86`).

One disposition is **not** as clean as claimed, and one whole class of interaction was never
examined. Those are BLOCKER 1 and MAJOR 4 below.

---

## BLOCKER 1 — the ladder has no run-phase guard, so it probes and now **escalates** tasks inside aborted and terminal runs, destroying the documented `hpipe abort` / `hpipe resume` contract

**Claim.** spec:384-386: "Unchanged through `main.ts:236`. Then the two `applyStalls` calls replace
the two `sendProbes` calls at `main.ts:238-268`." spec:334-339 keeps steps 1-3 of candidate
selection "unchanged from today": `row.stallable`, `row.stallWhen`, `probePaneFor`. spec:502-503
lists a live-verification step for abort/resume, but only for the **run** counter: "`hpipe abort` a
run at the cap, then `hpipe resume`: it must probe again, not escalate 60 minutes later in silence".

**Problem.** `taskStallCandidates` has no guard on the *run's* phase. It iterates `run.tasks`
directly and gates only on `taskRow(task.phase).stallable` (`stall.ts:71-86`), and the supervisor
feeds it `runs` — every current-schema run in the session — not `advancing` (`main.ts:254-255` vs
`main.ts:143`). `cmdAbort` sets `run.phase = 'done'` and touches **nothing else**
(`cli.ts:292-302`): tasks keep their live phases, which is the whole point of "worktrees and
branches left alone. Undo: `hpipe resume`" (`cli.ts:301`, documented at `smoke.md:477`).

Today that costs one wasted prompt per task per phase entry, because `alreadyProbed` bounds it at
one (`stall.ts:83`, `:101`) and the probe mutates no state. The ladder removes that bound (**A16**,
spec:153) and replaces it with a persisted counter and a **state transition**. So after this change,
an aborted run's live tasks are:

1. probed every `TASK_STALL_MINUTES` **forever** for A18-excluded rows, into a pane the human
   deliberately walked away from — and `abort` "releases the repo for a new `hpipe start`"
   (`smoke.md:477`), so `run.orchestrator_pane` on the dead run is very likely the same terminal the
   *new* run is now driving from (`orchestrator_pane` is never cleared — the only writers are
   `cli.ts:40`, `actions/claim.ts:32`, `orchestrator.ts:55`);
2. for the nine escalation-eligible rows, **moved to `escalated`** three thresholds later — 180
   minutes at the shipped `TASK_STALL_MINUTES: 45` (`config.ts:27`).

That second one is unrecoverable by the documented undo. `cmdResume` restores only `run.phase` and
`run.phase_entered_at` (`cli.ts:313-317`); it does not walk `run.tasks`. So `hpipe abort` followed by
`hpipe resume` four hours later returns a run whose tasks are all `escalated`, each with
`escalated_from` stamped (`machine.ts:92`), each `holdsFiles: true` (`phases.ts:131`), each in
`TERMINAL_BAD` so every dependent gates to `blocked-on-failure` (`gating.ts:6-8`, `:34-38`) — and the
only way back is one `hpipe rewind … --task` per task. `smoke.md:477` promises `resume` "puts it back
where it was". After this change that is false.

This is not hypothetical. The incident ledger this issue was filed from is still on disk and is in
exactly this state:

```
$ python3 -c "…" /Volumes/stein/.local/state/herdr/plugins/stein.pipeline/runs/personal/berean-os-20260916-berean-os-issue-batch-ujku.json
run phase done
t1 done ... t3 merge ... t6 plan-review
history: … 09-16 21:44 run execute->done : aborted from execute
```

`t6` sits in `plan-review` — `stallable: true`, `signal: 'verdict'`, therefore escalation-eligible
under A18 — inside a run whose phase is `done` because a human aborted it. Ship the ladder and a
supervisor started on the `personal` session probes `t6` every 45 minutes and escalates it.

The spec's own precedent argues against this: `pickOneAdvance` exists precisely to stop a
pane-releasing run from consuming the driver (`tick.ts:99-115`), and the spec cites that skip twice
(spec:88-89, spec:502-503) without noticing the stall block never had it.

**Fix.** Guard candidate selection on the run's row, matching `pickOneAdvance` exactly — in both
`stallCandidates` and `taskStallCandidates`:

```ts
if (runRow(run.phase).releasesPane === true) continue   // `done` and `escalated`
```

`phases.ts:70-72` gives `releasesPane: true` to both run `escalated` and run `done`, so one predicate
covers the aborted run, the completed run and the escalated run. Add it to the Data-and-control-flow
section as an explicit step 0, add the assumption to the table, and add two tests to
`test/stall.test.ts`: *an aborted run's live tasks produce no candidates* and *a run in `escalated`
produces no task candidates*. Then extend live-verification step 5 to assert the task half too:
abort a run with a task mid-`implement`, wait past `TASK_STALL_MINUTES × (probeMax + 1)`, and confirm
the task is still in `implement` and `hpipe resume` restores the run intact.

---

## MAJOR 2 — the prompt rewrite replaces the placeholder but leaves the two sentences that consume it, so the exact defect the issue addendum names survives for seven of the nine `{{awaiting}}` rows

**Claim.** spec:259-260: "`stallAwaiting(run, task, hpipe)` replaces `{{artifact_path}}` with
`{{awaiting}}`". spec:295: "`prompts/stall-probe.md:7`'s *'it will not ask again for this phase'* is
deleted." The Scope's prompt item is spec:48 — "`prompts/stall-probe.md`, including `:7`" — and the
only prompt assertions in the testing strategy (spec:473-476) are that the file no longer contains
`will not ask again` and does contain `{{awaiting}}` and `{{ladder}}`.

**Problem.** The template's other two lines are never touched:

```
prompts/stall-probe.md:3   This phase has been open {{minutes}} minutes and nothing has appeared at:
prompts/stall-probe.md:5       {{artifact_path}}
prompts/stall-probe.md:9-10 …If you finished but wrote the file somewhere else, move it to the path above.
```

Line 5 becomes `{{awaiting}}`, and per the spec's own table (spec:262-272) `{{awaiting}}` is a real
filesystem path for exactly two rows — `artifact` and `verdict`. The other seven entries are English
sentences: `a pushed PR for <branch> (#<issue>)`, `another task to release the files this one
declared`, `an answer to the open decision`, `a worktree adopted for a dispatched task`, `this task's
worktree to be removed`, `<hpipe> dispatch --done to close intake`, `whatever clears <phase>`. So
`implement` — the single most common worker row, `signal: 'pr'` (`phases.ts:109`) — still renders:

```
This phase has been open 45 minutes and nothing has appeared at:

    a pushed PR for fix/15-stall-escalation (#15)

… If you finished but wrote the file somewhere else, move it to the path above.
```

That is verbatim the defect the issue's 2026-09-17 addendum raises and the ruling put in scope: *"It
tells a worker that misfiled its artifact to move the file to the path above, and the path above is a
sentence."* P3 fixes the *value* for artifact rows; the sentence that consumes the value is still
wrong for everything else, including a row the spec escalates on. `blocked-on-decision` is worse
still: "nothing has appeared at: / an answer to the open decision", addressed to the orchestrator.

The spec is elsewhere scrupulous about the prompt not asserting something false — spec:295-297
deletes `:7` and then adds a second reason it must not claim answering stops the clock. The same
standard was not applied one line up or four lines down.

**Fix.** Compose the whole waiting clause at the call site, not just its object, exactly as **A25**
already does for `{{ladder}}`. Give `stallAwaiting` a second return channel — a boolean `isPath`, or
have it return the full sentence — and restructure the template to two placeholders:

```
This phase has been open {{minutes}} minutes. {{awaiting}}

{{ladder}}

If you are waiting on the human, say so now rather than waiting silently.
```

where `{{awaiting}}` is either ``Nothing has appeared at:\n\n    <abs path>\n\nIf you finished but
wrote the file somewhere else, move it there.`` for `artifact`/`verdict`, or ``This phase is waiting
for <sentence>.`` otherwise. Add the regression to `test/prompts.test.ts`/`test/stall.test.ts`: the
rendered `pr`-row probe contains neither "appeared at" nor "path above".

---

## MAJOR 3 — A7's hold is unbounded, and NG1 is declined on a justification A7 falsifies: in the one case where a richer liveness signal would decide differently, the ladder decides nothing, forever

**Claim.** spec:131-132: "**NG1** richer liveness (git-dirty) — #15 direction 3, declined; **the
ladder decides the same either way**." spec:428 (error table): "Held actor never stops reporting
`working` | **Never escalates**; re-checked once per `threshold` | A live pane with a running agent. A
dead one emits `pane.exited` → `failed` (`tick.ts:72-81`)." spec:526-528: "**What would have helped
the incident is the ladder in this spec**, via the tasks: a rate-limited agent reports something
other than `working`, so **A7** does not hold it and it escalates at 180m."

**Problem, three parts.**

*The non-goal's justification is falsified by the assumption.* The hold at spec:373-377 suppresses
the escalation branch — transition included — for as long as `agentStatus(actorPaneId) === 'working'`,
with no cap and no configurable bound. The scenario in which git-dirty liveness would change the
answer is precisely "the pane claims to be working and nothing is being produced" — an agent wedged
mid-tool-call, or a CLI sitting on an auto-retry countdown. In that scenario the ladder does not
"decide the same either way"; it decides *nothing*, indefinitely, which is the 13-hour silence #15
exists to end. NG1's one-line dismissal is the only justification the spec offers for declining
direction 3 of the issue, and it does not survive A7.

*The load-bearing empirical claim is uncited.* spec:527 asserts that a rate-limited agent reports
something other than `working`. Nothing in the spec, the research note, or the repo supports it — I
searched the research note for `usage limit`, `rate limit` and `working` and the only hit is an
unrelated quote of `stall-probe.md:7`. The installed `herdr 0.9.0` documents no status taxonomy
(`herdr agent get --help` prints three lines: "Show an agent / Usage: herdr agent get <target> /
Arguments: <target>"), and `Herdr.agentStatus` just forwards whatever `agent get` returns
(`herdr.ts:68-71`). The incident ledger is suggestive in the wrong direction: `t2`'s last recorded
`agent_status` is `"working"` while its phase is `done`. If the premise is wrong, then the ladder's
own closing argument — that it would have prevented the incident it was filed for — is wrong with it.

*No test, unit or live, exercises the hold.* Live verification is called "not optional" (spec:492)
because "DI with fakes hides wiring bugs", and steps 1-5 (spec:496-503) cover probing, persistence,
status, A18 exclusion and abort/resume. None of them parks an actor reporting `working` past the cap.
The unit list does cover A20's cadence (spec:454), but against a fake `agentStatus` — which is
exactly the class of coverage this repo's history says does not settle the question.

**Fix.** Two changes, both inline:

1. Bound the holds. `stall_holds` already exists and already persists; gate on it the same way
   `stall_probes` is gated — escalate once `stall_holds >= probeMax` regardless of reported status,
   or add `STALL_HOLD_MAX` beside `STALL_PROBE_MAX` in `config.ts`. At the shipped defaults that puts
   a permanently-`working` worker at 45 × (3 + 3 + 1) = 315 minutes rather than never. Record the
   trade in the assumption table: a false escalation costs a `TERMINAL_BAD` cascade
   (`gating.ts:6-8`), which is the cost A18 was narrowed to avoid, so the orchestrator should
   confirm the number.
2. Rewrite NG1's justification to what is actually true — the ladder does *not* decide the same
   either way under A7; direction 3 is declined because the bounded hold makes the residual
   acceptable — and add live-verification step 6: hold a pane at `working` past the cap and record
   what `herdr agent get` reports for an agent at a usage limit.

---

## MAJOR 4 — `src/cli.ts` is declared by task t1 (#9) in the live ledger; the spec records its basis as the ruling's "unheld" and never re-checks it

**Claim.** Files table, spec:69: `| `src/cli.ts` | A23 ruling — `cmdRewind` **and** `cmdResume` (see
conflict below) |`. The ruling the row points at says: "Plus, under the 2026-09-17 ruling, the
**unheld** `src/cli.ts` (`cmdRewind` only), `src/lib/types.ts`, `src/lib/machine.ts` and
`test/cli-commands.test.ts`." The spec's Open decisions (spec:547-551) escalates only the
`cmdRewind`-vs-`cmdResume` half of that sentence.

**Problem.** The live ledger contradicts the word "unheld":

```
$ …/runs/pipeline/herdr-plugin-pipeline-20260917-bug-fixing-and-enhancements-qc13.json
t1 fix/9-artifact-paths  #9  plan-review
   ['src/cli.ts', 'src/lib/worker-prompt.ts', 'src/supervisor/tasks.ts',
    'src/supervisor/deliver.ts', 'prompts/worker-brief.md']
t2 fix/15-stall-escalation #15 spec-review
   ['src/supervisor/stall.ts', 'src/supervisor/main.ts', 'prompts/stall-probe.md',
    'src/lib/status.ts']
```

`src/cli.ts` is in t1's `files`, alongside `src/supervisor/deliver.ts`. Pass-1's BLOCKER 2 was
exactly "the live ledger shows `deliver.ts` is declared by the sibling task t1 (#9)", and this spec's
response was to re-verify holdings and make `deliver.ts` import-only (spec:22, spec:77-79). The same
ledger line, read once more, also names `cli.ts` — and the spec records it as unheld-by-ruling
without checking. (The rest of the ruling's grant *is* clean: `types.ts`, `machine.ts`, `config.ts`
and every test file appear in neither task's `files`, so spec:70-75 is otherwise accurate.)

The consequence is not a certain merge conflict — #9's artifact-path work most plausibly touches the
`Task` literal at `cli.ts:79-96`, while this change touches `cli.ts:178-187` and `:313-317` — and the
spec does carry a real mitigation at spec:504-508 ("A real conflict in `src/cli.ts` … is a stop and
an `hpipe decide`"). The defect is that the record is wrong and the orchestrator's grant rests on a
false premise, in the one dimension this pipeline's `files` declarations exist to police
(`gating.ts:19-29`, `status.ts:38-55`).

**Fix.** Change the Files-table basis for `src/cli.ts` from "A23 ruling" to "**declared by t1 (#9)**
in the live ledger; granted by the A23 ruling on a stated 'unheld' premise the ledger contradicts —
see the Pre-PR gate", and fold it into the existing Open decision so the orchestrator confirms the
grant knowingly rather than re-confirming only the `cmdRewind`/`cmdResume` half. No code change.

---

## MINOR 5 — A22's "unconditional" is contradicted by the spec's own hold branch

spec:191-193 states the rule as a blockquote: "The `escalated` transition and its `persist` happen
**unconditionally**. Only the *send* of `stall-escalate` may be skipped or fail." The pseudocode
eleven paragraphs later does not do that: spec:373-377 `continue`s out of the escalate branch on
`agentStatus === 'working'`, skipping the transition and the persist. The intended meaning — "not
gated on the delivery channel", which is what pass-1's MAJOR 4 was about — is defensible, but A22 is
a labelled assumption an implementer will try to honour literally, and read literally it deletes A7.
Reword to: "Once the escalate branch is reached, the transition and its `persist` are unconditional;
only the *send* may be skipped or fail. The A7 hold is a decision not to escalate **yet**, taken
before the branch, and is the sole condition on the transition."

## MINOR 6 — "the only `saveRun` in the loop" is false; there are two

spec:180-181: "the only `saveRun` in the loop (`main.ts:217`) runs *before* the stall block
(`main.ts:238-268`)". `main.ts:136` — `if (changed) for (const run of runs) await saveRun(stateDir, run)`
— is also inside the `for (;;)` loop. The conclusion is unaffected (both precede the stall block), but
the sentence is the load-bearing evidence for the persistence fix and should be exact: "both
`saveRun` sites in the loop (`main.ts:136`, `:217`) run before the stall block".

## MINOR 7 — `dispatch` is not alone among run rows in lacking `stallWhen`

spec:211: "which is also why `dispatch`, alone among run rows in having no `stallWhen`, cannot
escalate a healthy run." `branch-review` has no `stallWhen` either (`phases.ts:64-66`); only `execute`
carries one (`phases.ts:58-59`). The distinction the sentence is reaching for is that `dispatch` is
the only *unguarded* run row that A18 also excludes — which matters, because `branch-review` is
unguarded **and** escalation-eligible, so a run whose orchestrator is legitimately mid-review
escalates at 60 minutes unless A7 holds it. Say that instead; it is the more useful observation and
it is true.

## MINOR 8 — A15 surfaces escalated **tasks** only, while the ladder also escalates **runs**

The Goal (spec:127-129) promises an escalated record is "surfaced in `hpipe status`". A15 (spec:152,
spec:403-412) adds a warning inside `taskWarnings` (`status.ts:17-59`), which loops `run.tasks` only.
A run escalated by the ladder out of `branch-review` at 60 minutes gets no ⚠ and no recovery hint —
just `run_id [escalated] title` from `status.ts:95-97` — while being frozen, because
`pickOneAdvance` skips it (`tick.ts:109`). Pre-existing for `advanceRun`-driven escalations, but the
ladder makes it a routine outcome. Add the mirror line beside `intakeWarning` (`status.ts:61-71`):
`⚠ run escalated from branch-review 62m ago — needs a human; \`hpipe rewind <run> branch-review\` resumes it`,
using `run.escalated_from` (`types.ts:95`), and assert it in `test/status.test.ts`.

## MINOR 9 — `prompts/stall-escalate.md` is named four times and specified nowhere

spec:74, spec:150 (A10), spec:392 and spec:473 all reference the new prompt; none gives its content
or its variable bag. Contrast `probe`, whose bag is spelled out at spec:384-386 — the escalate line
at spec:390-392 says only "render `stall-escalate`". `render` throws on any placeholder the bag does
not resolve (`render.ts:11`), and `test/prompts.test.ts:68-76` will require it to use `{{hpipe}}`
rather than a literal, so the shape is not free. State the bag (`run_id`, `phase`, `task_flag`,
`minutes`, `probes`) and one sentence on how it differs from the existing `escalate.md`
(`prompts/escalate.md:1-17`), which is rendered only on an `advanceLoopingRow` transition
(`tasks.ts:78-86`) and whose "This phase hit {{pass}} review passes without clearing" is wrong for a
stall.

---

## What is right, and should survive

Checked, not padding:

- **A18's narrowing is the correct call and is fully verified** against `phases.ts`, including the
  reasons for excluding `blocked-on-files` (clears only when a sibling releases, `machine.ts:186-189`)
  and `blocked-on-decision` (waits on a human). The `stallWhen` precedent at `phases.ts:32-39` is the
  right one to cite, and the observation that excluded rows lose nothing human-visible checks out
  (`status.ts:21-26`, `:38-55`).
- **A24's two-counter split genuinely resolves pass-1's MINOR 8.** The due rule
  `threshold × (probes + holds + 1)` yields a constant cadence (probe *k* falls at *k* × threshold),
  so A2's "constant, not exponential" is preserved, and the reason string counts only sends.
- **A20's cost arithmetic is right.** 10 h at `TICK_MS: 1000` (`config.ts:23`) is ~36,000 `agent get`
  calls; counting the hold reduces it to one per threshold.
- **The A7 `actorPaneFor` fix is correct.** All nine escalation-eligible rows are `actor: 'worker'`
  or `'orchestrator'`, so the function always resolves the right pane, and the `!== 'working'` gate
  rather than `isAgentReady` (`machine.ts:30-32`) correctly keeps `blocked` escalatable.
- **The superseded-premises arithmetic is correct.** 13 h at `TICK_MS: 1000` is ≈46,800 ticks, not
  33; 33 over 780 minutes is one per ~24 minutes; and `deliveriesFor` only fires when the tick
  produced text (`main.ts:159`, `deliver.ts:53`). The research note's causal claim really is wrong,
  and saying so explicitly is the right call.
- **A21 is the right guard for NG2**, and the reasoning about why `table.test.ts:30-37` is
  insufficient is exact — `merge` has `actor: 'orchestrator'`, so adding `stallable: true` to it
  would pass that test unchanged.
- **The escalated-task / `blocked-on-files` interaction is handled**, not ignored: `status.ts:47-52`
  already offers `hpipe release --task <holder>` as the escape when the holder is `escalated`.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 3
