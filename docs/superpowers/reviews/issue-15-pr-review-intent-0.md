# PR #28 — stage-1 intent review (pass 0)

**Target.** PR #28, `fix/15-stall-escalation` → `main`, 35 commits, `mergeStateStatus: CLEAN`.
**Measured against.** Issue #15 including the *Scope narrowed — 2026-09-17* ruling and *Ruling 2*;
`docs/superpowers/specs/2026-09-17-issue-15-design.md`;
`docs/superpowers/plans/2026-09-17-issue-15-plan.md`.
**Stage 1 only.** Does it do what was asked, completely, and nothing else. Code quality, naming and
structure are stage 2 and are not reported here.

## What I re-derived rather than took on trust

| Claim in the PR body | Result |
| --- | --- |
| `bun test` → 388 pass / 0 fail | **Confirmed.** 388 pass, 0 fail, 856 expect() calls, 33 files. |
| `bun run typecheck` → silent | **Confirmed.** `tsc --noEmit`, exit 0, no output. |
| 10 ticks one second apart on a 780-minute-old record → **1 probe, 0 escalations**, through the real `listRuns`/`saveRun` cycle | **Confirmed independently.** Scratch driver outside the repo, real `newRun`/`saveRun`/`listRuns` against a temp state dir, real `taskStallCandidates`/`applyStalls`: tick 1 produced one `probe` candidate and ticks 2–10 produced none; the on-disk JSON after tick 1 held `stall = {at, run_at, last_probe_at: <now>, probes: 1, holds: 0}` and did not move again. The run-level path behaves identically (`branch-review`, `STALL_MINUTES` 15): 1 probe, 0 escalations. |
| Both prompts render | **Confirmed.** Rendered `stall-probe` and `stall-escalate` with the exact bags `src/supervisor/main.ts:245-256` and `:258-284` pass; no unresolved placeholder, and `{{hpipe}}` in `stall-escalate.md:14` expands to the absolute CLI invocation via `renderPrompt` (`src/lib/render.ts:46`). |
| `git status --porcelain` empty | **Confirmed** before this file was written. |

The "no file declared by #9 is touched" claim also holds — see *Scope*.

## Acceptance criteria — issue #15 as narrowed

| Required | Where | Verdict |
| --- | --- | --- |
| Re-probe instead of one-probe-then-silence | `src/supervisor/stall.ts:56-59`; `stallKey`/`taskStallKey`/`alreadyProbed` are gone (no hits anywhere in `src/`) | met |
| Persist the counter so it survives the per-tick `listRuns` re-read | `StallState` on `Run` and `Task` (`src/lib/types.ts:49-59`, `:95`, `:120`); `applyStalls` persists on every bump (`src/supervisor/stall.ts:242-243`, `:253-254`), wired to real `saveRun` at `src/supervisor/main.ts:244`; round-tripped in `test/stall.test.ts:452` and again in my own driver | met |
| Escalate at a cap | `src/supervisor/stall.ts:65` (`probes >= probeMax`), transition at `src/supervisor/main.ts:264-266`; `STALL_PROBE_MAX` default 3 (`src/lib/config.ts:10`, `:29`, `:44`) | met |
| Escalation narrowed to `signal` ∈ `artifact`/`verdict`/`pr` | `src/supervisor/stall.ts:20`, `:61`; pinned by `test/phases.test.ts:57-63`, which computes the probe-only set from the real rows rather than restating it | met |
| The task probe's missing `artifact_path` | `stallAwaiting` returns the whole clause with a real absolute path (`src/supervisor/stall.ts:166-176`); `implement` now yields *"waiting for a pushed PR for …"* instead of `whatever clears implement` (`test/stall.test.ts:239-247`) | met |
| `prompts/stall-probe.md`, including *"it will not ask again for this phase"* | rewritten (`prompts/stall-probe.md:1-8`); `test/prompts.test.ts` asserts the file contains neither `will not ask again`, `appeared at`, `path above` nor `{{artifact_path}}` | met |
| Reset the counter wherever `phase_entered_at` is bypassed (`cmdRewind`, `cmdResume`) | done structurally, not by editing the CLI: `stallStateFor` requires **both** stamps to match (`src/supervisor/stall.ts:114-124`), so `cmdRewind`'s task and run restamps (`src/cli.ts:180`, `:186`) and `cmdResume`'s run restamp (`src/cli.ts:317`) each invalidate the state. I checked all five `phase_entered_at = ` writers; the enumeration in the spec is still exhaustive. `cmdResume` re-arms *tasks* too, which the ruling asked for and which `cmdResume` itself cannot do — `test/stall.test.ts:385` applies `cmdResume`'s exact mutation and asserts the task then gets a full threshold rather than escalating | met |
| Surface escalated records in `hpipe status` | task line `src/lib/status.ts:21-27`, run line `:119-128`, both keyed on `phase === 'escalated'`; the aborted-run false positive is pinned negatively in `test/status.test.ts` | met |

Ruling 2's specific demands are met as written: `last_probe_at` is persisted and due is
`now - last_probe_at >= threshold` (`src/supervisor/stall.ts:59`), the `(probes + holds + 1)`
multiplier is gone, the interval stays constant, and MAJOR 2 is resolved by the same field.

## Scope

`gh pr diff 28 --name-only` is exactly the spec's declared set: `prompts/stall-escalate.md` (new),
`prompts/stall-probe.md`, `src/lib/config.ts`, `src/lib/status.ts`, `src/lib/types.ts`,
`src/supervisor/main.ts`, `src/supervisor/stall.ts`, six test/doc files, and the issue's own
research/spec/plan/review documents.

- **No t1 (#9) file is touched** — `src/cli.ts`, `src/lib/worker-prompt.ts`, `src/supervisor/tasks.ts`,
  `src/supervisor/deliver.ts`, `prompts/worker-brief.md` are all absent from the diff. `deliver.ts`
  and `machine.ts` are imported only (`src/supervisor/stall.ts:2`, `src/supervisor/main.ts:16`).
- **`src/lib/phases.ts` (#19) is not modified.** `test/phases.test.ts:48-55` pins the exact stallable
  sets so widening them fails loudly; I mutation-checked that guard by adding `stallable: true` to
  the `merge` row and confirming it fails, then reverted (`git status --porcelain` clean).
- **The permitted-but-unused allowances stay unused:** `src/lib/machine.ts` and
  `test/cli-commands.test.ts` are untouched, correctly, since no CLI behaviour changed.
- **Nothing removed by the narrowing has been quietly retained.** No dead/unreachable pane detection
  (#24): the only pane-liveness text in `status.ts` is the pre-existing `livePanes` warning at
  `:107-110`, and the supervisor still does not act on it. No delivery retry budget (#25): no
  `DeliveryBudget`, and `attempts.delete` at `src/supervisor/main.ts:225`/`:232` is untouched. The
  PR body names both, plus the declined richer-liveness direction, under "Not done here".
- **No scope expansion.** `src/lib/config.ts` and the five test files are outside both tasks' holdings
  and are enumerated in the spec's own file table, which cleared spec review; the config key is a
  precondition for "escalate at a cap". The extra `test/phases.test.ts:57` guard is A18/A21 coverage,
  not new product behaviour.

## Tests exercise behaviour, not the implementation

The flagship regression (`test/stall.test.ts:305`) drives four consecutive ticks a second apart
against a 780-minute-old record and asserts **one** probe — it fails under the withdrawn design and
passes under this one, which is the property Ruling 2 was issued over. Pacing is asserted at the
boundary (`:44 min` → no candidate, `:45 min` → candidate). Persistence is asserted through real
`saveRun`/`listRuns` (`:452`) with a comment explaining why the fake-`persist` test above it is
insufficient. A26 (`:368`), A18 (`:338`), A27's bounded deferral (`:488`) and the
defer-only-on-`working` matrix (`:501`) all assert outcomes. `test/phases.test.ts` computes its
expected sets from the real rows rather than restating the filter. No test I read merely mirrors the
code it covers, and the five deleted tests each have a behavioural successor (the two
"already probed" tests → the pacing tests; "re-entering the phase" → the stale-stamp tests; "a probe
that could not be sent stays eligible" → `:435`; "no orchestrator pane" → `:298`).

## Plan divergence

None unexplained. The plan's sixteen steps map one-to-one onto the commit list, including the two
transitional shims being removed on schedule (`refactor: drop the transitional stall candidate key`).
The plan expected 387 tests at step 16 and the branch has 388; the extra one is the A18 probe-only
guard in `test/phases.test.ts:57`, an addition inside the step's own subject. The pre-PR rebase gate
is deferred, correctly: #9 is still open (PR #27, `OPEN`), and the PR body states the rebase and
re-run as a merge-order condition rather than claiming it was done.

---

## MAJOR 1 — the spec's mandatory live verification is neither reported nor declined

`docs/superpowers/specs/2026-09-17-issue-15-design.md:644` heads its list **"Live verification — not
optional"**, and `docs/superpowers/plans/2026-09-17-issue-15-plan.md:1364` repeats it as eight
numbered checks against a real supervisor with `TASK_STALL_MINUTES=1`, `STALL_PROBE_MAX=2`. Both
documents give the reason: unit tests with fakes previously hid a wiring bug in this exact feature.

The PR body's **Verification** section reports `bun test`, `bun run typecheck` and the
`listRuns`/`saveRun` derivation — all of which I confirmed — and says nothing about a live run. The
"Not done here, deliberately" section does not mention it either, so the reader cannot tell whether
it was done and unreported, or skipped.

This matters most for the one place the suite does not reach at all: **nothing in `test/` exercises
`src/supervisor/main.ts`.** The spec deliberately traded unit coverage for live check 4 — A22, that
an escalation whose send fails still leaves the record `escalated` — and that compensating control is
the one thing unreported. I discharged what I could from outside: check 1 (a real absolute path in an
artifact-row probe) via `test/stall.test.ts:221` and my own render; check 2 (`stall.probes` climbs and
`stall.last_probe_at` advances on disk) and check 3 (aged record → one probe, not a burst) via the
scratch driver above; checks 5–8 via `test/status.test.ts` and `test/stall.test.ts:338`, `:368`,
`:385`, `:488`. Check 4 I could only confirm by reading: `src/supervisor/main.ts:264-267` performs
`enterTaskPhase`/`enterRunPhase` and `saveRun` **before** the send, and `:269-274` returns after
persisting when `orchestrator_pane` is null. The ordering is right; it has never been executed.

Residual risk is lower than the spec assumed — `herdr.agentStatus` is already driven live elsewhere
in the same tick (`src/supervisor/main.ts:151`), so the new `agentStatus` dependency is proven
plumbing, and typecheck covers the rest of the wiring's shape. **Fix inline:** run the eight checks,
or at minimum checks 3 and 4, and state the result in the PR body. This does not reverse a decision,
change scope, or need a human judgment.

## MINOR 1 — the null-`actorPaneId` escalation path is asserted at the candidate level but never executed

`test/stall.test.ts:404` asserts that a paneless worker yields `actorPaneId: null` while its probe
still routes to the orchestrator. Nothing then drives that candidate through `applyStalls`, so the
branch that actually depends on it — `c.actorPaneId !== null` at `src/supervisor/stall.ts:250`,
which is what makes "the owner is gone" escalate **without** consulting an unrelated agent — is
untested. Every `applyStalls` test uses `mkTask`'s default `pane_id: 'w7:p1'`. The spec's testing
strategy lists this as one item ("the gate reads `actorPaneId`; a paneless worker escalates rather
than consulting the orchestrator") and only its first half landed. Two lines: a `pane_id: null`
worker at the cap with `agentStatus: async () => 'working'` must still produce `escalate:t1`.

---

Nothing else rose to a finding. The ladder, its anchor, its persistence, its narrowing, its run
guard, its bounded deferral, the rewritten prompts and the two `hpipe status` lines are all present,
match the spec as revised by Ruling 2, and are covered by tests that would fail if the behaviour
regressed.

VERDICT: CLEAR
