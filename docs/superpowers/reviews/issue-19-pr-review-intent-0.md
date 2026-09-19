# PR review (intent) — issue #19, pass 0

Target: PR #47, branch `fix/19-last-mile-stallable`, `b31c3bb..61d78f6` (21 commits, 11 of them
implementation).
Against: `gh issue view 19` including its **Ownership ruling — `test/integration/smoke.md`,
2026-09-19**; `docs/superpowers/specs/2026-09-18-issue-19-design.md` (CLEAR at pass 1);
`docs/superpowers/plans/2026-09-18-issue-19-plan.md`;
`docs/superpowers/reviews/issue-19-plan-review-0.md` (CLEAR, 2 MAJORs + 4 MINORs fixed inline);
`.claude/agents/plugin-dev.md`.

Stage 1 only: does the PR do what was asked, completely, and nothing more. Style, naming, structure
and efficiency are stage 2's.

## What I verified before reviewing

Everything below was measured in a throwaway copy of the branch (`git archive | tar -x`, `node_modules`
symlinked) outside the worktree. The worktree was never dirtied, the checkout's `src/cli.ts` was never
run against live state, and nothing was written to the ledger.

| Claim | Where | Measured |
| --- | --- | --- |
| `bun test` → 504 pass / 0 fail, 34 files | PR body | **504 pass / 0 fail, 34 files** ✅ |
| `bun run typecheck` clean | PR body | `tsc --noEmit`, no output, exit 0 ✅ |
| 488 before this change | PR body | `b31c3bb` → **488 pass / 0 fail** ✅ (+16, exactly the plan's +16 from its own 454 baseline) |
| Rebased onto `origin/main` at `b31c3bb` | PR body | `git merge-base HEAD origin/main` = `b31c3bb` ✅ |
| #44 touched none of the four declared files | PR body | #44's file list has `src/cli.ts`, `src/lib/ledger.ts`, the cli tests, `test/decide.test.ts`, `smoke.md`, `README.md`, prompts — none of `phases.ts`, `stall.ts`, `phases.test.ts`, `stall.test.ts` ✅ |
| §4c shifted to `:366` after #44 | PR body | `git show b31c3bb:test/integration/smoke.md` → the paragraph starts at **366**; the footer bullet is still at **199** ✅ |
| `cmdRewind` now validates the phase but `close` stays reachable | PR body | `src/cli.ts:311-321` validates against `TASK_ROWS`; `close` is a `TaskPhase`, so `rewind <run> close --task tN` is still accepted and the deadlock survives ✅ |
| "each of the eleven commits was run green before it was made" | PR body | built and ran each: 489 / 490 / 494 / 496 / 499 / 501 / 502 / 503 / 504 / 504 / 504, **0 fail at every one** ✅ |
| "every clause was rendered and checked for leaked placeholders and fallback hits" | PR body | re-ran the plan's step-12 script, extended to both `pr: 42` and `pr: null`: all ten renderings are clean, no `{{`, no `whatever clears` ✅ |
| "six probes at 45-minute spacing and no escalation" | PR body | `test/stall.test.ts:660-678` replays it and passes; `[45, 90, 135, 180, 225, 270]` ✅ |
| "neither out-of-holdings file is held by any sibling" | PR body, `spec:263-268` | read the live ledger directly: t1 (#21) = `src/cli.ts`, `src/lib/ledger.ts`, `test/cli.test.ts`, `test/cli-commands.test.ts`, `test/cli-argv.test.ts`, `test/ledger.test.ts`; t2 (#19) = the four declared. Neither holds `smoke.md` or `table.test.ts` ✅ |

## Issue acceptance

The issue offers two Directions and asks for either. The PR takes the first — *"Make the
human-blocked phases stallable with `probeTarget: 'orchestrator'`"* — and declines the second
(`hpipe status` / digest treatment) to #14, which the spec records as **NG2/NG3** and the PR body
states outright. That is a permitted choice, not a scope reduction.

All five rows named in the issue body are covered, including `escalated`, which the issue singles out
as *"arguably worse"*: `src/lib/phases.ts:118-132` (`ci`, `merge`, `close`, `teardown`) and `:139-142`
(`escalated`). `probeTarget: 'orchestrator'` is on exactly the three rows whose actor resolves to no
pane (`ci`, `teardown`, `escalated`), which is what `test/table.test.ts:30-37` requires; `merge` and
`close` resolve through `actor: 'orchestrator'` and are pinned as *not* carrying one
(`test/phases.test.ts:66-73`).

### Ownership ruling compliance, checked against the PR rather than the spec's claims

- **Own the file.** `test/integration/smoke.md` is edited, in two commits (`5969c27`, `61d78f6`).
- **Both stale sites.** `:199-204` (the footer bullet the spec originally missed) and §4c at `:366`
  are both rewritten, and nothing else in the file is touched — the diff is exactly two hunks.
- **Site 2 says what the ruling asked for.** `test/integration/smoke.md:200-207` now states that the
  footer reports a parked task only on a tick already sending a digest, and adds a second bullet
  naming the five rows, the orchestrator pane, the `TASK_STALL_MINUTES` cadence, the clause-not-
  fallback expectation and the never-escalated guarantee. The three falsified assertions
  (*"the footer is the only thing that reports it"*, *"a genuinely quiet window shows nothing"*,
  *"that residual gap is issue #19"*) are all gone.
- **Declare the out-of-holdings files, cite #37.** PR body does both, naming `smoke.md` and
  `test/table.test.ts`, the Ownership ruling, and #37 as third consecutive occurrence;
  `spec:246-275` (**A16**) carries the long form.
- **Confirm from the live ledger that no sibling holds them.** Confirmed independently against
  `…/herdr-plugin-pipeline-20260918-fix-run-resolution-and-the-last-mile-v0qh.json` (see table
  above). The spec's corrected statement of #21's holdings, including `test/ledger.test.ts`, matches
  the ledger exactly.

### Promised fixes from the prior reviews

Both accepted MAJORs from the plan review landed, byte-for-byte as prescribed:

- **Plan review MAJOR 1 — the `close` deadlock clause.** `src/supervisor/stall.ts:265-278` carries
  the widened clause and the *"Not 'the issue is still open'"* comment citing `machine.ts:168` and
  `:178-181`. Rendered: *"…If it is already closed, this phase cannot see it: it only counts a close
  it can tie to this task's recorded merge, so say so rather than waiting."* Pinned at
  `test/stall.test.ts:749-760` with the prescribed `toContain('already')` /
  `not.toContain('never clear')`.
- **Plan review MAJOR 2 — the `rollUpBucket` sibling assertion.** `test/stall.test.ts:717-723` plus
  the `import { rollUpBucket } from '../src/lib/gh'` at `:10`. `rollUpBucket([{bucket:'pass'},
  {bucket:'cancel'}])` → `'fail'` is now pinned, which it was not anywhere in the repo before.
- **Plan review MINOR 2 — the `{{` leak assertions on the two deadlock arms.** Present at
  `test/stall.test.ts:736` (`ci`, null PR) and `:747` (`merge`, null PR).
- **Plan review MINOR 4 — a scheduled live-verification step.** Plan step 13 exists
  (`plan:885-910`), and the PR body points at it by number rather than gesturing at the design.

Nothing from the two spec reviews is re-opened here.

## Scope

Twelve files change. Six are code/test, and they are exactly the four declared plus the two the
ruling authorises:

```
src/lib/phases.ts  src/supervisor/stall.ts  test/phases.test.ts  test/stall.test.ts
test/integration/smoke.md  test/table.test.ts
```

The other six are this issue's own pipeline artifacts under `docs/superpowers/{research,specs,plans,
reviews}/…issue-19…`, which every phase of the run is required to produce. No file outside that set
is touched. In particular the sibling's files (`src/cli.ts`, `src/lib/ledger.ts`, `test/ledger.test.ts`,
the cli tests) are untouched.

**Every non-goal holds.** Verified by reading the tree, not the diff summary:

- **NG1** — `ESCALATING_SIGNALS` is still `new Set(['artifact','verdict','pr'])` (`stall.ts:22`), and
  `test/phases.test.ts:58-64` re-asserts the escalating set is unchanged while the probe-only set
  grows 4 → 9.
- **NG2 / NG3** — `src/lib/status.ts` and `src/supervisor/tick.ts` are not in the diff at all.
- **NG4** — no `src/lib/config.ts` change; no new key.
- **NG6** — `queued` is still unstallable, and `test/stall.test.ts:110-115` now pins it alongside the
  four terminal rows.
- **NG7** — `stallWhen` is still unread by `taskStallCandidates` (`stall.ts:99-104`) and is guarded,
  not plumbed (`test/table.test.ts:79-85`).
- **NG8** — `schema_version` untouched; `grep -rn "stallable\|probeTarget\|stallWhen" src` returns
  only `phases.ts`'s declarations and `stall.ts:14`, `:82-83`, `:101`, so nothing new is serialised.
- **NG9 / NG11** — `src/lib/machine.ts` and `src/supervisor/ci.ts` are untouched; the three deadlocks
  are made audible in the clause and nowhere fixed. The runbook's recovery table (`:530-534`) is
  correctly left alone, since no new recovery exists.

`holdsFiles: true` is preserved on all five rows (**A15**), so file gating is unchanged.

## Tests — do they exercise behaviour?

I walked the spec's Testing-strategy list item by item. Every item has a real test, and the
behavioural ones drive the real `taskStallCandidates` / `applyStalls` rather than re-asserting the
source:

| Spec requirement | Test | Behaviour or restatement |
| --- | --- | --- |
| Candidates for all five rows, orchestrator pane | `stall.test.ts:633-641` | Behaviour — runs the real candidate path |
| **A2** safety: never escalates past the cap | `:643-658` | Behaviour — 20 rounds through `applyStalls` with a `sendEscalation` that throws |
| The measured 4h57m regression | `:660-678` | Behaviour — minute-by-minute replay, exact probe minutes |
| **A26** still holds for the new rows | `:680-686` | Behaviour |
| `escalated` clause, P2's false sentence | `:688-698` | Behaviour of `stallAwaiting` |
| `blocked-on-decision` unchanged after the reorder | `:700-704` | Behaviour — the regression the branch order could break |
| `ci` clause, and pass-1 MAJOR 2's negative | `:706-715` | Behaviour |
| `rollUpBucket` sibling assertion | `:717-723` | Behaviour of `gh.ts:19` itself |
| `ci` / `merge` null-PR deadlock clause + exit + no `{{` | `:725-737`, `:739-748` | Behaviour |
| `merge` clause, pass-1 MAJOR 1's negative | `:750-761` | Behaviour |
| `close` clause, plan-review MAJOR 1 | `:763-774` | Behaviour |
| `teardown` clause diagnoses nothing | `:776-785` | Behaviour |
| **MINOR 5** ordering invariant, non-vacuous | `:787-804` | Behaviour — drives an *escalatable* row (`implement`) through a real escalation and asserts the `from` and `awaiting_short` handed to `escalationText` |
| **A14** fallback becomes a run-level characterisation test | `:308-318` | Characterisation, and labelled as such |
| **A9** `stallWhen` guard | `table.test.ts:79-85` | Structural invariant, which is what `table.test.ts` is for |
| Pinned sets 10 → 15 and 4 → 9 | `phases.test.ts:49-64` | Table pins |

The two negative assertions (`not.toContain('cancelled')`, `not.toContain('throwing')`) are the kind
that can be vacuous, but both are paired with something that gives them teeth: the first with the
`rollUpBucket` pin, the second with positive assertions on the two causes the clause *does* name.
The `probes > probeMax` assertion in the A2 test stops the "never escalates" claim from passing just
because nothing was due.

I could not find a test that only restates the implementation.

---

## MINOR 1 — the escalated clause's run id is rendered but not pinned

**Claim.** `spec:733-736` requires, for the `escalated` regression test: *"An escalated task's clause
contains neither `open decision` nor `an answer to`, does contain `rewind`, and **renders the run id**
and `--task <id>`."*

**Problem.** The run id half is not asserted. `test/stall.test.ts:688-698` checks
`toContain('bun run /p/src/cli.ts rewind')`, `toContain('implement')`, `toContain('--task t1')` and
`not.toContain('{{')` — the run id sits between the first and second of those and is never examined.
Drop `${run.run_id}` from `stall.ts:181` and the clause becomes
`` `… rewind implement --task t1` `` — an unrunnable command shipped to the orchestrator every 45
minutes — while the suite stays green. The same omission is in the plan (`plan:309-319`), so this is a
spec requirement dropped at the plan stage rather than a deviation the PR introduced; the plan review
mapped A6 to its steps without descending to this assertion.

**Evidence.** `spec:733-736`; `test/stall.test.ts:688-698`; `src/supervisor/stall.ts:174-186`. The
behaviour itself is correct — rendered against a real `newRun`, the clause reads
`` `bun run /p/src/cli.ts rewind r-20260919-a-zz4u implement --task t1` `` — so this is a pin that is
missing, not a bug.

**Concrete fix.** One line in `test/stall.test.ts:688-698`, inside a declared file:

```ts
  expect(a.clause).toContain(run.run_id)
```

The two null-PR clauses interpolate `run.run_id` the same way and are unpinned for it too; the same
line beside `expect(a.clause).toContain('implement --task t1')` at `:734` and `:745` would close all
three, though only the `escalated` one was a stated spec requirement.

---

## Checks that passed

- **No silent scope reduction.** Every one of **A1**–**A16** is implemented; I found no assumption
  stated in the spec and skipped in the code. **A3**'s asymmetry, **A6**'s branch ordering (the
  `row.actor === 'human'` test precedes the `manual` branch at `stall.ts:174` vs `:279`), **A11** (no
  `prompts/*` edit), **A12**/**A13** (every clause with an exit names it) and **A15** are all present.
- **No scope expansion.** The only addition beyond the spec's own list is
  `test/phases.test.ts:66-73`, which pins **A3**'s probeTarget asymmetry — and that comes from the
  plan (`plan:108`), inside a declared file.
- **The four must-fail tests were all moved to their specified values**, including the narrowed loop
  at `stall.test.ts:110-115` (now `queued`, `done`, `failed`, `orphaned`, `blocked-on-failure`, which
  is wider than before, not narrower) and the run-level fallback test.
- **The plan is followed without unexplained divergence.** Every code block in steps 1–11 appears in
  the tree with the prescribed text; the only differences are line-wrapping inside the `stallAwaiting`
  docblock and two commit subjects that are more specific than the plan's (step 6 and step 7), both of
  which reflect the plan-review MAJOR 1 fix. The PR body's added *Rebase* section explains the one
  real divergence — the plan's 454 baseline is pre-#44 — and re-derives the moved anchors.
- **The spec-to-plan divergence on the `close` clause is explained.** `spec:480-487` still shows the
  narrow `closed` clause; the PR ships the widened one. That is the plan review's MAJOR 1, accepted
  and reasoned from `spec:164-167` (*"Making it audible is this issue's job"*), documented in
  `plan:553-620`, and restated in the PR body. Not a silent change.
- **The human-actor branch is safe where it now fires first.** The only other `actor: 'human'` row is
  the *run* `escalated` row (`phases.ts:70-71`), which is not stallable and is `releasesPane: true`;
  `stallAwaiting`'s only call sites are `main.ts:272` and `:289`, both on the stall path.
  `test/stall.test.ts:787-804` pins that an escalation in progress still renders the phase being left.
- **The reachability argument for `escalated` holds.** I checked the one way it could be vacuous:
  `branch-review` carries no `releasesPane` (`phases.ts:65-67`), so a run that advances past `execute`
  while holding an escalated task still produces candidates for it. `taskStallCandidates` skips only
  run `escalated` and run `done`, which is **A26** and is pinned at `:680-686`.
- **Self-hosting hazard respected.** No change to `schema_version`; nothing links or runs the
  checkout's `src/cli.ts`; the spec and PR body both say the tag-pinned install keeps the old table
  until release, and plan step 13 schedules the live check rather than claiming it.
- **PR title and closing keyword.** `fix: probe the last mile so a parked task never stops in silence`
  is conventional (`.claude/skills/conventional-pr-titles/SKILL.md`) and `fix` is right for a patch
  bump. The body ends with `Closes #19` followed only by the session trailer.
- **The "not yet observed live" admission is the honest one** for this surface
  (`.claude/agents/plugin-dev.md:53-59`), and it is paired with a numbered post-release step rather
  than left as a caveat.

MAJORS: 0
MINORS: 1

VERDICT: CLEAR
