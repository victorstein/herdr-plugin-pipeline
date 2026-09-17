# Adversarial spec review — issue #15, pass 2 (post-Ruling 2)

Target: `docs/superpowers/specs/2026-09-17-issue-15-design.md` at `54ca6b2`, reviewed against
`gh issue view 15` (including **Scope narrowed — 2026-09-17** and **Ruling 2 — 2026-09-17**),
`docs/superpowers/research/2026-09-17-issue-15-research.md`, and the preserved prior verdicts
`docs/superpowers/reviews/issue-15-spec-review-narrowed-r2-preserved.md` (VERDICT: BLOCKER —
1 BLOCKER / 1 MAJOR / 5 MINORs), `…-narrowed-r1-preserved.md` and `…-pass1-preserved.md`.

Baseline re-verified independently in this worktree:

```
$ bun test          → 351 pass, 0 fail, 767 expect() calls, 33 files [6.78s]
$ bun run typecheck → $ tsc --noEmit   (no output, exit 0)
```

spec:13 is accurate.

**Holdings re-read from the live ledger, not from any summary.**
`/Volumes/stein/.local/state/herdr/plugins/stein.pipeline/runs/pipeline/herdr-plugin-pipeline-20260917-bug-fixing-and-enhancements-qc13.json`,
read today:

```
run … execute  intake_closed=True
  t1 fix/9-artifact-paths   #9  merge        done     ['src/cli.ts','src/lib/worker-prompt.ts',
                                                       'src/supervisor/tasks.ts','src/supervisor/deliver.ts',
                                                       'prompts/worker-brief.md']
  t2 fix/15-stall-escalation #15 spec-review  working ['src/supervisor/stall.ts','src/supervisor/main.ts',
                                                       'prompts/stall-probe.md','src/lib/status.ts']
```

`src/cli.ts` **is** t1's, exactly as spec:52-55 says; `src/lib/types.ts`, `src/lib/machine.ts`,
`src/lib/config.ts`, `src/lib/phases.ts` and every test file named in the Files table appear in
neither task's `files`. The Files table (spec:56-65) and the "Never edited" list (spec:67-71) are
accurate against the ledger and against the ruling. t1 is at `merge`/`done`, so the Pre-PR gate
(spec:628-630) is about to become actionable rather than hypothetical.

**Removed features stay removed.** Dead-pane detection appears only as NG4 → #24 (spec:137-138) and
in *Superseded premises*; `DeliveryBudget` only as NG5 → #25 (spec:138) and in the Scope line
(spec:45-47). `grep -n "livePanes\|paneList\|DeliveryBudget\|A11\|A12\|A14\|A17\|A19\|A23\|A24"` over
the spec hits only the `*Deleted:*` line (spec:170), the Scope/NG lines and *Superseded premises*.
Nothing removed is quietly retained, and no finding below asks for either back.
`gh issue view 24` ("Stop delivering into a pane that cannot answer, without freezing the run") and
`gh issue view 25` ("Bound the supervisor's send paths with a delivery budget") both exist and OPEN,
as do #9, #19 and #26.

---

## What I re-verified from the "What changed" dispositions (spec:19-27)

Checked against the code, not restated from the prose. The three that carry the ruling are sound.

**BLOCKER 1 → A29 genuinely fixes it, and fixes it in the way Ruling 2 mandated.** The due rule is
now `now - last_probe_at >= threshold` (spec:228-232, spec:455) with `last_probe_at` a persisted
field on `StallState` (spec:201-202). The withdrawn `(probes + holds + 1)` multiplier appears
nowhere but in **P4** and *Rejected alternatives*; `grep -n "probes + holds"` over the spec returns
only spec:106 and spec:232, both describing it as deleted. No derivation is reintroduced to avoid
the field — the only derivation left is the *fresh* anchor
`Math.max(record.phase_entered_at, run.phase_entered_at)` (spec:219-223), which is the
never-probed fallback the prior review's own fix prescribed ("falls back to `phase_entered_at` when
stale/absent"), not a substitute for storage. Worked through against the incident's numbers
(780 min, `TASK_STALL_MINUTES: 45`, `config.ts:27`): a record with no `stall` reads fresh, anchored
780 minutes back, is due **once**, and `bumpStall` moves the anchor to `now`, so the next rung is a
full threshold away. The rung-per-tick burst at `TICK_MS: 1000` (`config.ts:23`) cannot occur. The
regression test is specified as the test that would have caught the pass-1 blocker — four ticks one
second apart, one probe, no escalation (spec:552-556) — and the live-verification step that all six
prior steps were missing is added (spec:616-618).

**MAJOR 2 → A30 is correct, and I verified the mechanism rather than the claim.** `cmdResume` is
`cli.ts:304-320` and mutates exactly `run.phase` (`:315`), `run.escalated_from` (`:316`) and
`run.phase_entered_at` (`:317`) — it does not walk `run.tasks`, so the prior review's complaint was
real. Stamping `run_at` closes it: on resume `stall.run_at !== run.phase_entered_at`, the state
reads fresh, and the anchor becomes `max(task.phase_entered_at, run.phase_entered_at)` =
`Date.now()`, so the recovered task gets a full threshold rather than escalating on the next tick
(spec:244-249). `cmdAbort` (`cli.ts:292-302`) does **not** restamp, which is why A26 has to carry
the during-abort half — and it does. No CLI file is touched, so the ruling's `cmdRewind` permission
is genuinely left unused (spec:54).

I attacked A30's collateral, because "re-arm every task ladder on every run transition" is the kind
of fix that buys one bug and sells another. It holds:

- `enterRunPhase` is reachable only through `advanceRun` (`grep -rn "enterRunPhase\|advanceRun("
  src/` → the definitions in `machine.ts` plus one call site, `deliver.ts:156`). There is no
  event-path or CLI-path restamp outside the five writers A28 enumerates.
- The run phase cannot oscillate. `intake→dispatch` fires on a registration edge (`machine.ts:57`);
  `dispatch→execute` fires once, on the first adoption, because `enterRunPhase` sets
  `phase_entered_at = Date.now()` which is later than any `adopted_at` (`machine.ts:64-65`);
  `execute→branch-review|escalated` requires `tasksAllTerminal` (`machine.ts:69-72`), by which point
  no task row is stallable. So a task's ladder is re-armed at most once, at the
  `dispatch→execute` boundary, exactly as spec:251-254 claims.
- The reverse hazard is handled too: a task that entered its phase one minute ago inside a run that
  entered its phase fifty minutes ago is **not** due, because the fresh anchor is a `max`, not the
  run's stamp.

**A28's writer enumeration is still exhaustive.** `grep -rn "phase_entered_at = " src/` returns
exactly the five sites at spec:238-240 — `cli.ts:180`, `cli.ts:186`, `cli.ts:317`,
`machine.ts:49`, `machine.ts:94` — plus the two creation literals (`cli.ts:85`, `ledger.ts:32`) the
spec calls out at spec:243.

**MINOR 3 → applied.** `probeMax: number` is on `StallDeps` (spec:462) and is what `applyStalls`
reads (spec:483).

**MINOR 6 → applied, and the reasoning is right.** `cmdAbort` sets `run.escalated_from = run.phase`
then `run.phase = 'done'` (`cli.ts:298-299`), so `escalated_from !== null` would warn on every
aborted run. `phase === 'escalated'` is stated (spec:413) and the negative assertion is in the test
plan (spec:597-598) and in live step 4 (spec:619-620).

**MINOR 7 → applied.** `deliver.ts:53` is `if (p.text.length === 0 && p.events.length === 0)
continue`; `deliver.ts:51` is the `byPane` map. spec:27 and spec:645 now cite `:53`.

**A27's arithmetic re-derived from the code, not copied.** With the anchor at the last rung, probe
*k* lands at *k* × threshold and each hold consumes one threshold, so escalation is at
4 × 45 = **180m** and 7 × 45 = **315m** for tasks (`TASK_STALL_MINUTES: 45`, `config.ts:27`), and
4 × 15 = **60m** / 7 × 15 = **105m** for `branch-review` (`STALL_MINUTES: 15`, `config.ts:26`).
spec:288-289 matches exactly. The gate reads `actorPaneFor`, not `probePaneFor` — correct, because
`probePaneFor` collapses a paneless worker onto the orchestrator (`stall.ts:24`, pinned by
`test/stall.test.ts:147-151`) — and `!== 'working'` rather than `isAgentReady` (`machine.ts:30-32`)
correctly keeps `blocked` escalatable. `Herdr.agentStatus` does return `'unknown'` on failure
(`herdr.ts:68-71`), so the fail-open row in the error table is true.

**A18 and A21 reproduce by execution.** Filtering `TASK_ROWS` (`phases.ts:89-141`) and `RUN_ROWS`
(`:51-73`) by `stallable` gives the ten task rows and three run rows at spec:588-594 row for row;
filtering those by `signal ∈ {artifact,verdict,pr}` gives exactly the nine escalating and four
probe-only rows at spec:317-320. The excluded rows' justifications check out: `blocked-on-files`
clears only when a sibling releases (`machine.ts:186-189`), `blocked-on-decision` waits on a human
(`phases.ts:126-129`), run `dispatch` is `worktree` (`phases.ts:54`) and `execute` is `gate`
(`phases.ts:56`). `branch-review` really does lack `stallWhen` — `execute` is the only run row that
has one (`phases.ts:58-59`).

**A26 and the run-level asymmetry.** `releasesPane: true` is on exactly `escalated`
(`phases.ts:71`) and `done` (`phases.ts:72`); `pickOneAdvance` uses the identical predicate
(`tick.ts:109`). `escalated` is `releasesPane` and **not** `terminal`, so the choice of predicate is
right for the stated reason. And the asymmetry argument is sound: neither `escalated` nor `done` is
stallable, so `stallCandidates` cannot produce a candidate for them. I checked the freeze hazard the
scope ruling warned about for #24 — a run escalated by the ladder does silence all its tasks under
A26 — and it is not reachable: the only escalatable **run** row is `branch-review`, which is
downstream of `tasksAllTerminal`, so there are no live tasks left to freeze.

**A13/A25/P2c.** `render` is a single `String.replace` that throws only on placeholders present in
the *template* (`render.ts:8-14`) and `renderPrompt` injects `hpipe` into the bag (`render.ts:46`),
so spec:396-401's argument for passing `hpipe` in as a rendered value is exactly right, and
`test/prompts.test.ts:68-76` strips `{{hpipe}}` before asserting, so the new prompt's
`{{hpipe}} rewind …` line passes it. The `gate` clause ("waiting for `<hpipe> dispatch --done` to
close intake") is precisely true of when `execute` can be probed at all, given `stallWhen`
(`phases.ts:58-59`) and `intakeWarning` (`status.ts:61-71`).

**The superseded-premises section is correct.** The research note does say what spec:642-644 quotes
(research:78-79), 13 h at `TICK_MS: 1000` is ≈46,800 ticks and not 33, and a delivery really is only
attempted when the tick produced text (`main.ts:159`, `deliver.ts:53`). `main.ts:234` really does
delete the per-pane counter in the give-up branch.

Five things the revision did not finish are below. None reverses a decision, changes scope, or needs
a human judgment; all five are inline edits to the spec.

---

## MINOR 1 — the MINOR 4 fix is half-applied: `stall-escalate.md` still uses a placeholder the spec never defines, and it is the one the prior review named explicitly

**Claim.** spec:24, the disposition table: *"**MINOR 4** — `stall-escalate.md` uses
`{{awaiting_short}}`, defined nowhere → **Accepted.** `stallAwaiting` now returns `{ clause, short }`;
the escalation prompt takes `short`."*

**Problem.** The prior review's MINOR 4 asked for two things (r2-preserved:256-269): define
`awaiting_short`, **and** *"State the bag in full — `run_id`, `phase`, `minutes`, `probes`,
`task_flag`, `awaiting_short` … Also pin `task_flag` to the existing convention:
`` ` --task ${task.task_id}` `` for a task and `''` for a run (`tasks.ts:84`, `escalate.md:15`)."*
Only the first was done. The new template at spec:389 still reads

```
    {{hpipe}} rewind {{run_id}} {{phase}}{{task_flag}}
```

and `grep -n "task_flag" docs/superpowers/specs/2026-09-17-issue-15-design.md` returns **one** line —
spec:389, the template itself. spec:392 defines only `{{awaiting_short}}` and `{{probes}}`. The
placeholder is live: `render` throws `unresolved template placeholder: task_flag` when the bag omits
it (`render.ts:9-13`), and `test/prompts.test.ts` cannot catch it — the only checks the spec adds for
this file (spec:605) are that it *contains* `{{awaiting_short}}` and `{{probes}}`, which a
`task_flag`-less bag passes. The blast radius is bounded by A22 (the transition and its `persist`
precede the send, spec:500-506), so the cost is a lost escalation prompt inside the tick's `try`
(`main.ts:269-271`), not a lost transition — which is why this is a MINOR and not worse. But the
disposition table records the finding as closed and it is not.

**Fix.** State the bag for `stall-escalate` in full at spec:392, and pin `task_flag` to the existing
convention it must match: `` ` --task ${task.task_id}` `` for a task, `''` for a run — the shape
`escalate.md:15` already renders and `tasks.ts:84` already supplies. Add
`expect(text).toContain('{{task_flag}}')` to the spec:605 prompt assertions, or better, assert the
rendered escalation for a run contains no trailing `--task`.

## MINOR 2 — the MINOR 5 fix is half-applied: `bumpStall` is given a signature but no semantics, and the semantics it omits are the ones the BLOCKER-1 fix rests on

**Claim.** spec:25: *"**MINOR 5** — `bumpStall`/`stallCountsFor` used but never defined or placed →
**Accepted.** `StallState` is declared in `types.ts` … the helpers live in `stall.ts`. Signatures
given."* The `types.ts` justification is genuinely verified —
`grep -cE "^(export )?(function|const|class)" src/lib/types.ts` → `0`, so that file really is
declaration-only today and putting `StallState` there is consistent.

**Problem.** The prior review asked for the home **and** the body: *"give `bumpStall` its three
lines, including the `at:` stamp that spec:204 says every bump writes"* (r2-preserved:279-280). The
revision gives spec:213 — `export function bumpStall(run, record, kind, now): void` — and nothing
else. Nowhere does the spec say that a bump **writes `at` and `run_at`**. That is not a cosmetic
omission: `stallStateFor` returns the stored state *only when both stamps match* (spec:216), so a
`bumpStall` that increments `probes` and sets `last_probe_at` without stamping produces a state that
`stallStateFor` rejects on the very next tick, reads fresh, re-anchors to `phase_entered_at`, and is
therefore due again immediately — which is **P4 verbatim**, at one rung per tick. The spec's own
persistence note (spec:508-512) reasons about exactly this failure for the `persist` half
(*"without A4 a bump made in the stall block is discarded … which would restore exactly the rung-per-
tick behaviour of P4"*) and leaves the identical hazard on the `bumpStall` half unstated.

**Fix.** Give `bumpStall` its body at spec:211-214, explicitly replacing the whole state rather than
mutating a field:

```ts
export function bumpStall(run: Run, record: Run | Task, kind: 'probes' | 'holds', now: number): void {
  const s = stallStateFor(run, record)
  record.stall = { ...s, at: record.phase_entered_at, run_at: run.phase_entered_at,
                   last_probe_at: now, [kind]: s[kind] + 1 }
}
```

and add the unit assertion that closes it: *after a bump, `stallStateFor` on the unchanged record
returns the stored state, not a fresh one.* The spec:559 persistence test asserts the round trip
through `listRuns` but would pass on a same-tick in-memory read even if the stamps were never
written.

## MINOR 3 — spec:47 says `announceDecisions`' unbounded retry is "unfiled"; #25's body says it owns it

**Claim.** spec:45-48, *Scope — Out, moved*: *"`announceDecisions`' unbounded retry
(`tasks.ts:293-309`) → unfiled, named so it is not mistaken for handled."*

**Problem.** It is filed. `gh issue view 25`, under **Directions**:

```
- Cover the existing unbounded site (`tasks.ts:293-309`), not only the new ones — it is the one
  with a measured history.
```

The issue body even opens with *"`announceDecisions` (`src/supervisor/tasks.ts:293-309`) is a
pre-existing unbounded retry"* and cites the same line range the spec does. The spec routes
`DeliveryBudget` and the `main.ts:234` reset bug to #25 in the same sentence and gets both right —
#25's body names `main.ts:223-236` as the extraction site — so this is stale bookkeeping left over
from the churn that created #25, not a disagreement. Recording a filed item as unfiled is the same
class of error as recording an unapplied fix as applied: it invites someone to file it twice, and it
understates what #25 already commits to.

**Fix.** At spec:47, change "unfiled" to "→ **#25**", which is where its own issue body puts it, and
drop the "named so it is not mistaken for handled" clause — it is handled, by #25.

## MINOR 4 — the escalation send targets `run.orchestrator_pane`, which is `string | null`, and the error table that enumerates pane-nullability does not cover it

**Claim.** spec:501: *"`escalate`, in order: `enterTaskPhase(…, 'escalated', …)` → `saveRun` →
render `stall-escalate` → send to `run.orchestrator_pane`."* spec:535, the error table: *"Probe pane
is `null` | No candidate (`stall.ts:38-39`, `:76-77`) | Unchanged."* spec:529: *"`actorPaneId` is
`null` | Escalate without the gate."*

**Problem.** The table covers both *probe* panes and the *gate* pane and says nothing about the
*escalation target*. `run.orchestrator_pane` is `string | null` (`types.ts:96`), initialised `null`
(`ledger.ts:34`), and `Herdr.agentPrompt(target: string, …)` (`herdr.ts:73`) takes a non-nullable
string, so under `strict` (`tsconfig.json`) the implementer hits a compile error at the send and has
to invent a behaviour the spec did not choose. The case is reachable by construction: a task in a
worker row with `task.pane_id` set produces a candidate through `probePaneFor`'s
`taskPane ?? run.orchestrator_pane` (`stall.ts:24`) **without** consulting
`run.orchestrator_pane` at all, so a candidate can exist while the escalation target is `null`. The
repo already has the convention — `announceDecisions` opens with `if (run.orchestrator_pane === null)
return` (`tasks.ts:294`) — and A22 already decides the right answer in principle (*"a failed send
loses a prompt, never a transition"*, spec:505), so the state change must still happen.

**Fix.** Add a row to the error table at spec:523-537: *"`run.orchestrator_pane` is `null` at
escalation | Transition and `persist` happen; the prompt is skipped and logged | **A22** — **A15**
is the surface"*, and say so in the `escalate` ordering at spec:500-501 so the null check lands after
`saveRun`, not before the transition.

## MINOR 5 — two citations rotted in this revision

**(a) The header cites a review path that no longer exists.** spec:4 cites
`docs/superpowers/reviews/issue-15-spec-review-1.md`. `ls docs/superpowers/reviews/` has no such
file: `git show --stat ddd5086` renamed it to `issue-15-spec-review-narrowed-r2-preserved.md` (and
`-0.md` to `…-narrowed-r1-preserved.md`) one commit after the spec revision at `54ca6b2`, precisely
to stop the rewind-reset pass counter from clobbering it (#26). The spec is the one document that
must point at the review it answers, and it now points at nothing. Update spec:4 to
`issue-15-spec-review-narrowed-r2-preserved.md`; the commit message for this spec (`54ca6b2`) has
the same stale path and is immutable, which is all the more reason for the document to carry the
live one.

**(b) A paired citation is transposed.** spec:70-71: *"`enterTaskPhase`/`enterRunPhase`
(`machine.ts:45-51`, `:90-96`)"*. `machine.ts:45-51` is `enterRunPhase` and `machine.ts:90-96` is
`enterTaskPhase` — the names and ranges are in opposite order. Both ranges are individually correct,
so swap the names.

---

## Noted, not findings

- The A13 table (spec:342-352) carries a `worktree | task (teardown)` clause and the test plan
  (spec:576) mandates covering "both `worktree` cases", but `teardown` has no `stallable: true`
  (`phases.ts:124`), so no stallable task row can reach it — and A21 exists precisely to pin that
  (spec:588-594). It is dead until #19 widens the set, and harmless; I mention it only because the
  spec elsewhere treats "verified by executing the filter" as its standard and this row is not
  reachable under that filter.
- spec:548-550 reads *"All 20 tests pass `alreadyProbed` positionally (`grep -c "new Set(" ` →
  18)"*. Both halves are true and the conclusion is true — the remaining two construct
  `new Set<string>()` (`test/stall.test.ts:155`, `:168`), which the literal pattern misses — but the
  parenthetical under-counts its own claim. `grep -c "new Set"` → 20 would be the honest evidence.
- spec:297 cites `test/stall.test.ts:146-151` for the paneless-worker routing test; the test begins
  at `:147` and `:146` is blank.
- spec:640-646 asserts the incident's 33 deliveries went into a pane that was *alive*. The
  arithmetic half (≈46,800 ticks, not 33; ~1 per 24 minutes) is airtight and verified; the "alive"
  half is an inference about the incident that contradicts the issue's own framing ("delivering
  digests into a dead orchestrator pane") and is not checkable from this repo. It changes nothing
  here, since both the pane question (#24) and `main.ts:234` (#25) are out of scope, but it is
  stated more strongly than the evidence supports.

## What is right, and should survive

Beyond the dispositions re-verified above:

- **The ruling is obeyed literally where it matters.** `last_probe_at` is persisted, due is
  `now - last_probe_at >= threshold`, the constant interval is kept, the parsimony argument is
  recorded as withdrawn in *Superseded premises* so it cannot drift back, and MAJOR 2 is fixed with
  the same field rather than with a second mechanism.
- **The `src/cli.ts` permission is declined deliberately, and the reason is the right one**
  (spec:653-655): an enumeration of reset sites already went stale once, and keeping t1's file out of
  the change set shrinks what must survive the mandated post-merge rebase. With t1 now at
  `merge`/`done` in the live ledger, that is about to pay off.
- **The live-verification section is the part of this spec that earns the most.** It names the exact
  thing unit tests with fakes cannot reach — reading `stall.probes` and `stall.last_probe_at` off
  disk between probes (spec:614-615) and restarting the supervisor against an aged record
  (spec:616-618) — which is the repo's own documented failure pattern applied to itself.
- **A22's scoping, the `persist` argument (spec:508-512) and the error table's honesty** about the
  unbounded probe retry ("Today's behaviour, unchanged; #25 owns it. Named, not hidden") are the
  right way to hand a known gap to another issue instead of pretending it away.
- **The clock-moves-backwards row** (spec:537) — `now - last_probe_at` goes negative, so the ladder
  degrades to silence rather than to a burst — is the kind of edge nobody asked for and it is the
  correct answer.

The BLOCKER and the MAJOR from the previous pass are both genuinely fixed, verified against the
code and not merely asserted, and the fixes survive the attacks I could construct against them. The
five MINORs are spec-text edits with no design consequence.

VERDICT: CLEAR
