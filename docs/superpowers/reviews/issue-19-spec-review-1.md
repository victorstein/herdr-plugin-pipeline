# Adversarial spec review — issue #19, pass 1

Target: `docs/superpowers/specs/2026-09-18-issue-19-design.md` at `c59b40b`, reviewed against
`gh issue view 19` (including the **Ownership ruling of 2026-09-19**),
`docs/superpowers/research/2026-09-18-issue-19-research.md`,
`docs/superpowers/reviews/issue-19-spec-review-0.md`, the live ledger, and the cited text of
#13 / #14 / #21 / #24 / #25 / #32 / #37 and `docs/superpowers/specs/2026-09-17-issue-15-design.md`.

## Baseline, re-verified independently in this worktree

```
$ bun test          → 454 pass, 0 fail, 1072 expect() calls, 34 files [8.39s]
$ bun run typecheck → $ tsc --noEmit   (no output, exit 0)
```

spec:16-17 holds at `c59b40b`.

## The ten pass-0 dispositions, checked against what the spec now says

Each was checked against the spec's current text, not against its own table. **All ten are applied,
and applied correctly.** In particular:

- **BLOCKER 1 / the ruling.** The ruling directs option (b) and imposes four specific obligations.
  All four are met: **A16** states outright that `test/integration/smoke.md` *and*
  `test/table.test.ts` are outside t2's declared `files`; it cites #37 with its title and body quoted
  verbatim (`gh issue view 37`); it confirms from the ledger that no sibling holds either; and
  **A10** covers **both** stale sites. I read the ledger myself —
  `~/.local/state/herdr/plugins/stein.pipeline/runs/pipeline/herdr-plugin-pipeline-20260918-fix-run-resolution-and-the-last-mile-v0qh.json`:

  ```
  t1 #21 plan-review ["src/cli.ts","src/lib/ledger.ts","test/cli.test.ts",
                      "test/cli-commands.test.ts","test/cli-argv.test.ts","test/ledger.test.ts"]
  t2 #19 spec-review ["src/lib/phases.ts","src/supervisor/stall.ts",
                      "test/phases.test.ts","test/stall.test.ts"]
  ```

  Neither file, and no prefix of either under `filesOverlap` (`gating.ts:19-21`), appears in t1's
  list. `test/ledger.test.ts` is now listed in both the Files section and **Never edited**, as the
  ruling required. I also grepped the whole runbook for further stale sites
  (`grep -n "#19\|stall\|probe\|parked\|escalat" test/integration/smoke.md`): `:199-204` and
  `:359-361` are the only two, and `README.md` and `.claude/agents/plugin-dev.md` enumerate nothing
  that this change falsifies. A10's "no other section is touched" is correct.
- **MAJOR 1.** The must-fail list is now **exhaustive**, verified rather than asserted. I applied
  `phases.ts` + `stall.ts` verbatim from spec:275-300 and spec:370-445 to a scratch copy and ran the
  **unedited** suite:

  ```
  (fail) the stallable set is exactly what #15 assumed — widening it belongs to #19
  (fail) exactly the four probe-only rows are outside the escalating signals
  (fail) a task phase whose row is not stallable is never probed
  (fail) an unrecognised signal falls back to naming the phase
   450 pass, 4 fail
  ```

  Exactly four, exactly the four named. With the spec's four edits plus the **A9** guard applied:
  **455 pass / 0 fail**, `tsc --noEmit` clean. The narrowed loop
  (`['queued','done','failed','orphaned','blocked-on-failure']`) and the run-level rewrite
  (`stallAwaiting(runAt('intake', LONG_AGO), null, 'hp')` → `whatever clears intake`) both pass.
- **MAJOR 2.** `pickOneAdvance` (`tick.ts:237-248`) does have exactly three skips, the P4 table
  classifies each correctly, and the rewritten `teardown` clause is true of all three plus the
  `main.ts:178-245` throw. Its `short` is byte-identical, so `stall.test.ts:304` still passes.
- **MINORs 1, 3, 5, 6** re-verified against source: `status.ts:21-27` exists and is pull-only;
  `SETTLED` (`teardown.ts:12-15`) includes `escalated` and `machine.ts:69-72` routes such a run to
  `branch-review`; #15's spec line 46 is `` `phases.ts` → **#19** `` (`:138` also correct, `:293`
  and `:693`/`:696` correct).

## Computed values and the simulation, recomputed from the real table

Driven from a scratch tree through the shipped `taskStallCandidates` + `applyStalls`, not read:

```
stallable sorted: ["blocked-on-decision","blocked-on-files","ci","close","escalated","implement",
                   "merge","plan","plan-review","pr-review-intent","pr-review-quality","research",
                   "spec","spec-review","teardown"]                 15
probeOnly (table order): ["dispatch","execute","blocked-on-files","ci","merge","close","teardown",
                          "blocked-on-decision","escalated"]         9
probes over a 4h57m merge park: 6 at minutes [45,90,135,180,225,270]
final phase: merge  stall: {"at":0,"run_at":0,"last_probe_at":16200000,"probes":6,"holds":0}
```

Matches spec:617-630 and spec:336-337 exactly, stall-state JSON byte for byte. Every clause in
**A6** renders with no `{{`, including both `pr === null` deadlocks, the `<phase>` fallback, and
`blocked-on-decision` still returning `'an answer to the open decision'` after the reorder.

The findings below are what survived that.

---

## MAJOR 1 — P3 enumerates two permanent deadlocks; there is a third, it is on `merge`, the research note recorded it, and the new `merge` clause is false in it

**Claim.** spec:120-127 (**P3**): *"**two** of the five can never clear at all, and nothing says
so"* — `ci.ts:12` and `tasks.ts:278`, both `task.pr === null`. On that basis **A6** ships one
deadlock branch per row, and the error table (spec:590) lists exactly one deadlock failure mode:
*"`task.pr === null` in `ci` or `merge`"*.

**Problem.** The `merge` row has a second, independent way to park forever, and it has nothing to do
with `pr`. `src/lib/machine.ts:165-171` — the very range the spec cites at spec:125 — is an **edge**,
not a level:

```ts
    case 'merge': {
      if (!s.merged) return null
      if (s.mergedAtMs === undefined || s.mergedAtMs <= task.phase_entered_at) return null   // :167
```

A PR merged **before** the task entered `merge` is never seen, and `phase_entered_at` only ever moves
forward. The behaviour is deliberate and pinned: `test/machine-task.test.ts:68-76`, *"merge requires
mergedAt to postdate phase entry, not merely MERGED"*, asserts `advanceTask` returns `null` for
`mergedAtMs: task.phase_entered_at - 1_000`.

**This is a regression against the spec's own research.** `research:67` states the condition in full:

> \| `merge` \| `merged` \| `machine.ts:165-171`, needs `prView().merged` **and**
> `mergedAtMs > phase_entered_at` \| a human merging \|

The spec quotes the same line range and drops the second conjunct.

**Reachable, by two ordinary routes.**

1. The human or the orchestrator merges the PR before the supervisor moves the task out of
   `pr-review-quality`/`ci` — merging is explicitly the human's move (`prompts/merge.md:9`,
   `README.md:8`) and nothing serialises it against `ciTransitions`' 30s poll
   (`config.ts:32`, `main.ts:142-145`).
2. `hpipe rewind <run> merge --task tN` after a merge. `cmdRewind` re-stamps
   `task.phase_entered_at = Date.now()` (`cli.ts:206`) and does not touch `task.pr` or
   `task.merged_at_ms`, so the rewind itself creates the deadlock — and this is the first row of the
   runbook's own recovery table (`smoke.md:530`).

**Why it matters here and not only in `machine.ts`.** In that state the new clause reads, every 45
minutes, forever:

```
This phase is waiting for you to merge PR #42 (feat/x). Merging is yours, not the plugin's;
nothing merges automatically.
```

The PR **is** merged. This is precisely the defect the spec makes **P2** out of and that pass-0's
MAJOR 2 made it rewrite the `teardown` clause for: a probe asserting a diagnosis it cannot support —
here one that instructs an action already taken and names no exit, which is also what **MINOR 4**
was accepted to prevent. Worse, the state appears to have no recovery at all: rewinding to `merge`
re-creates it, and rewinding to `close` leaves `merged_at_ms === null` with
`issue_closed_at_entry === false`, so `machine.ts:178-182`'s `closedByMerge` is unsatisfiable too.
That makes spec:516-517's *"The recovery table (`:530-534`) needs no change"* an untested claim about
the one row the operator would actually reach for.

**Concrete fix (all inside declared files plus spec prose; no change to NG9):**

1. Add the third deadlock to **P3** with its cite (`machine.ts:167`, pinned by
   `test/machine-task.test.ts:68-76`) and its two reachable routes.
2. Extend the `merged` branch's non-null clause so it does not assert the merge has not happened —
   e.g. append: *"If PR #42 is already merged, this phase cannot see it: only a merge that postdates
   this phase's entry counts (`machine.ts:167`). Say so rather than waiting."* No new state is
   needed; `stallAwaiting` cannot distinguish the case from the record, which is exactly why the
   sentence must not presuppose one side of it.
3. Add the error-table row, and either name the recovery or record in a Non-goal that there is none
   and that it belongs in a follow-up issue beside #37.

---

## MAJOR 2 — the new `ci` clause tells the orchestrator that a cancelled CI run waits forever; it does not, it fails the row back to `implement`

**Claim.** spec:400-405, the non-deadlock `ci` branch:

```
This phase is waiting for CI to report on PR #42. Check it with `gh pr checks 42` — a run that is
queued, cancelled or was never triggered reports no conclusion, and this phase waits on it forever.
```

spec:449-454 defends the branch on the grounds that *"the commands are the ones the phase prompts
already print"* and that *"a probe that contradicted the phase prompt would be worse than the
fallback."*

**Problem.** Two of the three examples are right; `cancelled` is wrong, and it is wrong in the
direction that produces an unnecessary human intervention. `rollUpBucket` maps a cancelled check to
`fail` (`src/lib/gh.ts:16-22`):

```ts
  if (rows.some((r) => r.bucket === 'fail')) return 'fail'
  if (rows.some((r) => r.bucket === 'cancel')) return 'fail'      // :19
```

`ciTransitions` writes that bucket onto the task (`ci.ts:14-20`), `gatherSignals` hands it through
(`tasks.ts:214`), and `advanceTask`'s `ci` case advances on `fail` (`machine.ts:158-163`) into
`advanceLoopingRow`, which returns the task to `implement` with the `ci-red` prompt, or escalates it
at `maxPasses` (`machine.ts:113-127`). A cancelled run is therefore one of the *fastest* ways out of
`ci`, not a way to sit in it forever.

(`queued` → `pending` and "never triggered" → `rows.length === 0` → `pending` (`gh.ts:17,20`) are
both correct: `pending` is neither `pass` nor `fail`, so `machine.ts:159` returns `null`.)

**Concrete fix.** Drop `cancelled` from the list — *"a run that is queued or was never triggered
reports no conclusion"* — or state the true behaviour: a cancelled check rolls up as `fail`
(`gh.ts:19`) and sends the task back to `implement`. One word, inside `src/supervisor/stall.ts`,
which t2 declares. Worth a line in the new `ci` coverage in `test/stall.test.ts` asserting the clause
does **not** claim a cancelled run waits forever, the same way the spec already asserts the
`teardown` clause does not contain `throwing` (spec:664-665).

---

## MINOR 1 — live-verification step 7 cannot produce the clause it expects

spec:713: *"7. A `ci` row whose PR was deleted: the probe reports the deadlock **and its rewind
exit** (**A13**)."* Deleting a PR does not clear `task.pr` — nothing does; `grep -rn "\.pr = " src`
returns only `machine.ts:143` (set) and the two constructors (`cli.ts:106`, `:114`), and `cmdRewind`
(`cli.ts:203-208`) leaves it alone. So the deleted-PR case takes the `task.pr !== null` arm and the
operator sees *"waiting for CI to report on PR #42 … waits on it forever"*, with no `rewind` exit.
Run as written, step 7 fails, and spec:718's *"treat any difference as a finding"* rule then turns a
correct implementation into a false finding. **Fix:** restate the step as the state that actually
reaches the branch — a task rewound into `ci` with no recorded PR (`hpipe rewind <run> ci --task tN`
on a task that never produced one) — and, if the deleted-PR case is still wanted, verify it against
the non-null clause instead.

## MINOR 2 — the probe contradicts itself in the two states the spec worked hardest on

`stall-probe.md:3-5` renders `{{awaiting}}` and then `{{ladder}}`, and `ladderFor` is unconditional
for a non-escalatable row (`stall.ts:227-229`): *"This is a standing nudge — this phase is not
escalated automatically, and **clears when whatever it is waiting for arrives**."* Rendered against
the new branches, the `pr === null` probe reads:

```
This phase can never clear on its own: no PR number was recorded for this task, so no merge is
ever seen. `… rewind … implement --task t1` sends it back to the row that produces one.

This is a standing nudge — this phase is not escalated automatically, and clears when whatever it
is waiting for arrives.
```

"can never clear on its own" and "clears when whatever it is waiting for arrives" are adjacent and
opposed; the same applies to the `teardown` clause, whose whole point (**P4**) is that nothing will
arrive. The spec checks `ladderFor` only for the property that it promises no bound (spec:322,
spec:570), never for whether its sentence is true of the new rows. **Fix:** either note the
divergence and accept it, or give `ladderFor` a second non-escalatable form for a clause that has
already said the row cannot clear — `stall.ts` is declared, and `test/stall.test.ts:317-325` already
pins the two existing sentences.

## MINOR 3 — A11's justification for not touching `stall-probe.md` only covers the rows it was written for

spec:749-752 rejects editing the template because #15 made `{{awaiting}}` a whole paragraph and
*"the nine worker rows' wording was settled over three review rounds."* The fixed tail is
`stall-probe.md:1,7-8`: *"# Still working? …"*, *"If you are still working, ignore this. If you are
stuck or waiting on a human, say so now rather than waiting silently."* That is written for a worker
being asked whether it is alive. Three of the five new rows address the orchestrator as the actor
who must **act** (`merge`, `close`) or relay (`escalated`), and for those the template's closing line
grants the recipient explicit permission to ignore a nudge about work that is its own move — the
behaviour #19 exists to end. Nothing here is false, and the fix is out of scope (`prompts/*` is in
**Never edited**), but **A11** should say that it considered the new recipients rather than resting
on the worker-row precedent, since the two are not the same argument.

---

## What is right, and worth saying

- **Every pass-0 disposition is real.** I checked each against the spec's current text and then
  against a scratch application; none is half-applied, and the "nothing is partially applied" claim
  at spec:6 survives an attack aimed squarely at it.
- **The ruling is complied with in full**, including the two obligations easiest to skip: the
  live-ledger confirmation that no sibling holds either file, and #21's `test/ledger.test.ts`.
- **The must-fail list is now exhaustive**, and I verified it the hard way rather than by grep:
  450 pass / 4 fail, the four named, nothing else.
- **A2 holds under attack.** `ESCALATING_SIGNALS` (`stall.ts:22`) excludes all five signals,
  `candidateFor:63,67` never yields `'escalate'`, and a 297-minute replay with an escalation-throwing
  fake produced 6 probes and no escalation. Nothing enters `TERMINAL_BAD`.
- **A3's asymmetry is right.** `table.test.ts:33` computes `hasPane` from `actor` alone; with
  `probeTarget` on exactly `ci`, `teardown` and `escalated` the suite is green, and adding it to
  `merge`/`close` would be noise.
- **A6's ordering is right and is load-bearing.** With `row.actor === 'human'` first,
  `blocked-on-decision` keeps `'an answer to the open decision'` and `escalated` stops being told it
  is waiting for a decision it never asked — the P2 defect the research measured.
- **P4's three-skip table is correct**, and the rewritten `teardown` clause is the rare case of a
  sentence that is true of every cause it could be describing.
- **The ledger-drift section is verifiable and verified**: nothing is serialised, `schema_version: 2`
  is the right call, and the self-hosting hazard is named.

Both MAJORs are the same shape as the one the spec already accepted and fixed — a clause that
asserts something the code cannot support — and both are repairable inside `src/supervisor/stall.ts`
and the spec's own prose, without reversing a decision, widening scope, or asking the human anything.
MAJOR 1 additionally needs the follow-up recorded, not fixed, which **NG9** already licenses.

MAJORS: 2
MINORS: 3

VERDICT: CLEAR
