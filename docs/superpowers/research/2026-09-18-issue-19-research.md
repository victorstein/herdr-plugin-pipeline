# Research — issue #19: the last mile is not stallable

Worktree: `fix/19-last-mile-stallable`, task `t2`, batch 3 (paired with #21).
Baseline on this branch before any edit: `bun test` → **454 pass / 0 fail / 1072 expect() calls**,
34 files, 7.99s; `bun run typecheck` → clean, no output. Branch head `9e792b5` (`chore(main):
release 1.2.7 (#43)`), working tree clean.

Everything below was executed in this worktree today. Where a claim could not be read off a file it
was produced by running the shipped code against a synthetic record; those scripts and their exact
output are quoted.

---

## 1. Tool and package versions actually installed

| Tool | Version | How |
| --- | --- | --- |
| Bun | `1.3.14` | `bun --version` |
| Node (present, unused by the plugin) | `v24.16.0` | `node --version` |
| TypeScript | `5.9.3` | `./node_modules/.bin/tsc --version`; `package.json` declares `^5.6.0` |
| `@types/bun` | `latest` | `package.json:11` |

There are **no runtime dependencies** and no build step — `package.json` has only `test`
(`bun test`) and `typecheck` (`tsc --noEmit`).

---

## 2. Which files own the behaviour

| File | What it owns here |
| --- | --- |
| `src/lib/phases.ts:89-141` | `TASK_ROWS`. The four rows in the issue are `:118-124`; the task `escalated` row is `:130-131`. `stallable`/`stallWhen`/`probeTarget` are declared at `:31-41`. |
| `src/supervisor/stall.ts` | The whole ladder. `taskStallCandidates:90-107`, the `stallable` gate at `:101`, `ESCALATING_SIGNALS:22`, `probePaneFor:13-17`, `candidateFor:51-74`, `stallAwaiting:161-219`, `ladderFor:226-233`, `applyStalls:257-283`. |
| `src/supervisor/main.ts:263-315` | Wiring: one `probeMax`, the `stall-probe`/`stall-escalate` render sites, and the two `applyStalls` calls at `:310` (run, `STALL_MINUTES`) and `:313` (task, `TASK_STALL_MINUTES`). |
| `src/lib/config.ts:27-29` | `STALL_MINUTES: 15`, `TASK_STALL_MINUTES: 45`, `STALL_PROBE_MAX: 3`. |
| `src/lib/machine.ts:158-184` | What actually clears `ci`, `merge` and `close`. |
| `src/supervisor/teardown.ts:17-41` + `src/supervisor/tasks.ts:137` | What clears `teardown`. |
| `src/supervisor/tick.ts:31-55`, `:119-139` | #13's `actionFor` and `parkedFooter` — the neighbouring mechanism, and the one this issue was ruled to complete. |
| `src/lib/status.ts:17-67` | `taskWarnings`. Covers `escalated`, open decisions, undelivered answers, `blocked-on-files` — and **nothing** for `ci`/`merge`/`close`/`teardown`. |
| `test/phases.test.ts:49-63`, `test/table.test.ts:30-37` | The two tests that pin the current sets. `phases.test.ts:49` is named *"the stallable set is exactly what #15 assumed — widening it belongs to #19"* — it fails by construction on any row this issue adds. |
| `test/integration/smoke.md:351-364` | §4c documents the ladder and **enumerates the probe-only rows by name**; widening the set makes `:359-361` stale. |

`src/cli.ts`, `src/lib/ledger.ts` and the cli tests are the sibling's (#21) and appear nowhere in
this list.

---

## 3. Current control flow, and what actually clears each row

`taskStallCandidates` (`stall.ts:90-107`) per tick:

1. skip the run if `runRow(run.phase).releasesPane === true` (`:98` — #15's A26);
2. per task, `if (!row.stallable) continue` (`:101`) — **the only gate**;
3. `candidateFor` resolves a probe pane (`:55`), returns `null` if there is none, and is due when
   `now - state.last_probe_at >= threshold` (`:61`);
4. `escalatable = ESCALATING_SIGNALS.has(row.signal)` where the set is `{artifact, verdict, pr}`
   (`:22`, `:63`); action is `escalate` only when `escalatable && probes >= probeMax` (`:67`).

So `stallable` is a single boolean with no per-row condition at the task level (see §5), and
escalation is gated a second time, on the **signal**.

What clears each of the five rows today:

| Row | Signal | Cleared by | Waits on |
| --- | --- | --- | --- |
| `ci` | `ci` | `ciTransitions` polls `gh pr checks` every `CI_POLL_SECONDS` (30) — `supervisor/ci.ts:5-25`, called at `main.ts:142-145`; the transition is `machine.ts:158-163` | GitHub |
| `merge` | `merged` | `machine.ts:165-171`, needs `prView().merged` **and** `mergedAtMs > phase_entered_at` | a human merging |
| `close` | `closed` | `machine.ts:173-184`, needs `issueClosed` plus `issue_closed_at_entry \|\| closedAtMs >= merged_at_ms` | GitHub's auto-close, else a human |
| `teardown` | `worktree` | `runTeardown` (`teardown.ts:17-41`) called first thing in `advanceTasks` (`tasks.ts:137`); **always** exits to `done` or `orphaned` on the first pass | nothing — it should never linger |
| `escalated` (task) | `manual` | `hpipe rewind` only | a human, by definition |

`teardown` is the odd one: it cannot sit unless `advanceTasks` is not reaching the run at all —
`pickOneAdvance` (`tick.ts:237-247`) skips a run with no `orchestrator_pane` or in a `releasesPane`
phase. A parked `teardown` therefore means "this run is not being driven", which is a different
fault from the other three.

---

## 4. Measured: what `stallable: true` alone would have done

The four rows and task `escalated` were run through the shipped `stallAwaiting`/`probePaneFor`
logic. Verbatim output:

```
--- ci ---        signal=ci      actor=none         escalatable=false probePane=w1:p1 holdsFiles=true
  short:  whatever clears ci
  clause: This phase is waiting for whatever clears ci.
--- merge ---     signal=merged  actor=orchestrator escalatable=false probePane=w1:p1 holdsFiles=true
  short:  whatever clears merge
  clause: This phase is waiting for whatever clears merge.
--- close ---     signal=closed  actor=orchestrator escalatable=false probePane=w1:p1 holdsFiles=true
  short:  whatever clears close
  clause: This phase is waiting for whatever clears close.
--- teardown ---  signal=worktree actor=none        escalatable=false probePane=w1:p1 holdsFiles=true
  short:  its worktree to be removed
  clause: This phase is waiting for this task's worktree to be removed.
--- escalated --- signal=manual  actor=human        escalatable=false probePane=w1:p1 holdsFiles=true
  short:  an answer to the open decision
  clause: This phase is waiting for an answer to the open decision.
```

Three findings, all load-bearing for the design:

**F1 — the blast radius the brief warns about does not exist for these five rows.** None of
`ci`/`merged`/`closed`/`worktree`/`manual` is in `ESCALATING_SIGNALS` (`stall.ts:22`). Adding
`stallable: true` and nothing else yields `action: 'probe'` forever: no `enterTaskPhase(…,
'escalated')`, so no `TERMINAL_BAD` membership (`gating.ts:6-8`) and no dependent cascade to
`blocked-on-failure` (`gating.ts:34-38`). The `merge`/`close` risk the brief flags is real only if
the design *also* widens `ESCALATING_SIGNALS`. `test/phases.test.ts:58-62` already pins the
probe-only set and would have to be extended either way.

**F2 — `stallAwaiting` does need changes, contrary to its own comment.** `stall.ts:154-158` claims
*"Keyed on `row.signal` … so #19 making more rows stallable needs no change here."* For `ci`,
`merged` and `closed` there is no branch, so it falls to `:218` and the probe reads *"This phase is
waiting for whatever clears merge."* — true but useless. Worse, `escalated` shares `signal:
'manual'` with `blocked-on-decision` and so takes the `:204` branch: an escalated task would be
probed with **"This phase is waiting for an answer to the open decision."**, which is simply false.

**F3 — every one of the five resolves to the orchestrator pane already.** `probePaneFor:13-17`
returns `run.orchestrator_pane` for `actor: 'orchestrator'`, for `actor: 'human'` and for no actor
at all. `probeTarget: 'orchestrator'` — which the issue's Directions suggest — is therefore a
**no-op on behaviour**; its only effect is satisfying `table.test.ts:30-37` for the actorless rows
(`ci`, `teardown`), which is exactly what `phases.ts:40` documents it as ("Required when `actor`
resolves to no pane and the row is stallable").

### The incident, replayed against the shipped ladder

`merge` was flipped to `stallable: true` in memory and the real `taskStallCandidates` + `applyStalls`
were driven minute-by-minute across t3's actual 4h57m `merge` park from the berean-os run of
2026-09-16, at shipped defaults (`TASK_STALL_MINUTES: 45`, `STALL_PROBE_MAX: 3`):

```
probes over a 4h57m merge park: 6 at minutes [ 45, 90, 135, 180, 225, 270 ]
final phase: merge stall state: {"at":0,"run_at":0,"last_probe_at":16200000,"probes":6,"holds":0}
```

Six probes into the orchestrator pane, no escalation, the task still in `merge`. That is the whole
behavioural delta of the one-line change — and it is **unbounded**: `probes` keeps climbing for as
long as the row is parked, because `ladderFor:227-229` returns the "standing nudge" sentence and
nothing ever caps a non-escalatable row.

---

## 5. A latent gap this issue will hit: `stallWhen` is dead at the task level

`stallCandidates` (run level) consults it at `stall.ts:83`. `taskStallCandidates` **does not** —
`:99-104` checks `row.stallable` and nothing else. Executed against the shipped code:

```
--- rows carrying a stallWhen ---
run : [ "execute" ]
task: []

--- does taskStallCandidates consult stallWhen? ---
candidates with stallWhen=()=>false on implement: 1
```

A task row given a `stallWhen` today is silently ignored. This matters because the natural way to
say "probe `ci` only when it has actually gone quiet" or "do not probe `teardown` on a run nobody is
driving" is a `stallWhen`, and that mechanism does not exist on this side of the table. Any design
that reaches for it must add the call site in `taskStallCandidates` as part of this issue.

Note also that `stallWhen`'s declared parameter (`phases.ts:39`) is run-shaped — `{ intake_closed,
tasks }` — with no task argument, so a task-level predicate needs a signature change too.

---

## 6. Boundary with the neighbouring issues

- **#13 (closed, shipped in #41)** — its *Scope ruling* section says, verbatim: *"`ci`/`merge`/
  `close`/`teardown` not being `stallable` is where that is fixed. Do **not** change
  `src/lib/phases.ts` here."* `parkedFooter` (`tick.ts:119-139`) only rides ticks that already emit
  a digest; `tick.ts:113-117` records the same limit in the code. `actionFor` (`tick.ts:31-55`)
  already keys on the row, and already returns `'YOUR move'` for `merge`/`close`.
- **#14 (open)** — claims the `hpipe status` half of #19's Directions explicitly, listing *"PRs
  parked in `merge` awaiting a human"* as something it must show, and carrying the batch-2 ruling to
  move `ageMinutes`/`actionFor` into `src/lib/`. **Option 2 of #19's Directions ("a distinct parked,
  awaiting-human treatment in `status`") is therefore #14's, not this issue's.** That leaves option
  1 — make the rows stallable — as the one #19 owns.
- **#32 (open)** — an undeliverable probe never climbs a rung (`stall.ts:264`). Widening the
  stallable set adds five rows to the population that defect applies to; it does not change the
  defect and is not this issue's to fix.
- **#24 / #25 (open)** — dead-pane detection and a delivery budget. Six extra probes per parked task
  land in the population #25 will later bound.
- **#15 (shipped, batch 1)** — `docs/superpowers/specs/2026-09-17-issue-15-design.md` lists **NG2
  widening `stallable` → #19** (`:138`), routes `phases.ts` to this issue (`:48`), and at `:617-618`
  says of its own guard test: *"`table.test.ts:30-37` only asserts a stallable row can be probed;
  adding `stallable: true` to `merge` would pass it."* The stronger guard it added is
  `test/phases.test.ts:49-56`.

---

## 7. Nearest existing example to model on

There is no prior commit that widens the stallable set — `git log --oneline -- src/lib/phases.ts`
returns exactly one commit, `6d3b840 feat: move design work into per-issue worker agents (#4)`, which
created the table. So the pattern to mirror is not a past `phases.ts` diff but the two rows already
shaped the way these five would be:

- **`blocked-on-files` (`phases.ts:105-106`)** — the closest structural match: no `actor`, a
  non-escalating signal (`files`), `stallable: true` **plus** `probeTarget: 'orchestrator'`, probed
  forever and never escalated. Its probe text is a dedicated branch in `stallAwaiting`
  (`stall.ts:198-203`) rather than the `:218` fallback, and it has a matching `hpipe status` warning
  (`status.ts:46-63`) and a `table.test.ts:30-37` obligation. That is the full checklist a new
  probe-only row has to satisfy, and it is the example to name.
- **`execute` (`phases.ts:56-59`)** — the only row with a `stallWhen`, and the precedent for "healthy
  while it waits, so do not probe it". Its comment (`phases.ts:32-38`) records *why* the condition
  exists: without one, `execute` was probed 15 minutes into every run.

For the test shape, `test/stall.test.ts` is the model — `mkTask`/`runAt` fixtures, a fixed `NOW`, and
per-row assertions on `taskStallCandidates(...).map(c => c.paneId)`. `test/phases.test.ts:49-63` is
the file whose two pinned sets must be updated in the same commit as any row change, and
`test/integration/smoke.md:351-364` is the operator-facing prose that goes stale with them.

---

## 8. Open questions the spec must answer (not decided here)

1. Which of the five rows become `stallable` — in particular whether `teardown`, whose only parked
   state means "the run is not being driven", is better served by a probe or by leaving it to #14.
2. Whether any of them should become *escalatable* (widening `ESCALATING_SIGNALS`). F1 says the
   default answer is no, and #15's spec `:693` already rejects it for correctly-parked rows.
3. Whether the unbounded standing nudge measured in §4 (6 probes over 4h57m, growing without limit)
   is acceptable, or needs a cap distinct from `STALL_PROBE_MAX`.
4. `stallAwaiting` branches for `ci`, `merged` and `closed`, and a fix for the false `manual`
   sentence on `escalated` (F2) — the one place the "no change here" comment is wrong.
5. Whether `stallWhen` is plumbed into `taskStallCandidates` (§5), and if so with what signature.

No `phases.ts` change alters on-disk run format — `stallable`, `probeTarget` and `stallWhen` are
read at tick time and never serialised (`ledger.ts` persists the `Run`, not the table), so
`schema_version` stays `2`. Confirmed by `grep -rn "stallable\|probeTarget\|stallWhen" src` — the
only readers are `stall.ts:14`, `:82-83` and `:101`.
