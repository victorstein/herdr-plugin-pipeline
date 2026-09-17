# PR #28 — stage-2 code-quality review (pass 0)

**Target.** PR #28, `fix/15-stall-escalation` → `main`. Diff read with `git diff 6008bce...HEAD`.
**Stage 2 only.** Whether the code is written the way this codebase is already written. Intent,
scope and requirements were settled in `issue-15-pr-review-intent-0.md` and are not re-litigated.
**Verified locally.** `bun test` → 389 pass / 0 fail, 33 files. `bun run typecheck` → silent, exit 0.
`git status --porcelain` was empty before this file was written, and is empty apart from it now.

## What I checked against the surrounding code, not against generic taste

Read in full before judging: `src/supervisor/{deliver,tasks,tick,teardown,ci,stall,main}.ts`,
`src/lib/{machine,phases,gating,status,predicates,render,ledger,badges}.ts`, and the pre-PR
versions of `test/{stall,status,phases,prompts}.test.ts`.

- **No dead or commented-out code is left behind.** `stallKey`, `taskStallKey`, `TaskStallCandidate`,
  `sendProbes` and the in-memory `probed` Set are all removed, and `git grep` finds no residual
  reference in `src/` or `test/`. The only importers of `./stall` are `src/supervisor/main.ts:16-19`
  and `test/stall.test.ts:5-8`.
- **No comment restates its next line.** Every comment added by this diff records a *why*: the anchor
  choice (`src/supervisor/stall.ts:57-58`), why `bumpStall` must rewrite both stamps (`:126-131`),
  why the run guard exists (`:93-95`), why the ladder sentence is composed in code rather than
  templated (`:203-206`), why the status predicate keys on `phase` (`src/lib/status.ts:119-121`).
  That matches the house style in `src/lib/phases.ts:60-63`, `:133-136` and `src/lib/render.ts:19-26`.
- **Side effects go through a `Deps` interface** (`StallDeps`, `src/supervisor/stall.ts:217-225`),
  matching `AnswerDeps` (`src/supervisor/tasks.ts`) and `advanceTasks`'s deps bag. No client is
  imported into the module.
- **`ESCALATING_SIGNALS: ReadonlySet<string>`** (`src/supervisor/stall.ts:20`) mirrors
  `TERMINAL_OR_SETTLED` (`src/lib/phases.ts:47`) and `SETTLED` (`src/supervisor/teardown.ts:14`)
  exactly — same shape, same placement, same widening. Not a divergence.
- **Nothing was duplicated.** `absoluteArtifactPath` is imported from `./deliver`
  (`src/supervisor/stall.ts:2`) rather than re-derived; `deliver.ts` does not import `stall.ts`, so
  no cycle. `stall-escalate.md` is not a copy of `escalate.md`: the reason paragraph and the three
  bullets differ, `{{pass}}` is correctly absent, and `test/prompts.test.ts` pins that difference.
- **Test design is strong.** `test/stall.test.ts:452` deliberately round-trips through real
  `saveRun`/`listRuns` with a comment explaining why the fake-`persist` test above it is not enough;
  `test/phases.test.ts:57-63` computes the probe-only set from the real rows rather than restating
  the filter. I mutation-checked two gates — `probes >= probeMax` → `>` at `src/supervisor/stall.ts:65`,
  and `holds < deps.probeMax` → `<=` at `:250` — and both are caught by `test/stall.test.ts:338`
  and `:488` respectively. Both mutations were reverted.

One finding below is structural and worth fixing; the rest are small.

---

## MAJOR 1 — the escalation's phase transition is written into `main.ts`'s wiring closure, unlike every other transition in the repo, and is consequently the only untested one

`src/supervisor/main.ts:264-265` performs the ledger transition inside the `StallDeps.escalate`
closure:

```
if (c.task) enterTaskPhase(c.run, c.task, 'escalated', why)
else enterRunPhase(c.run, 'escalated', why)
```

Every other `enterTaskPhase`/`enterRunPhase` call site outside `machine.ts` lives in a plain,
exported, testable supervisor module: `src/supervisor/tasks.ts:135`, `:140`, `:283`,
`src/supervisor/teardown.ts:28`, `:34`, `src/supervisor/tick.ts:63`, `:74`. Before this PR
`main.ts` contained **no** transition at all and did not import `machine`'s `enter*` functions —
`src/supervisor/main.ts:15` is new. `enterRunPhase` had no caller outside `machine.ts` whatsoever.

The closest sibling is `deliverPendingAnswers` (`src/supervisor/tasks.ts:256-286`), which does the
same job — decide, transition, send, and treat a failed send as "no transition consumed". It keeps
`enterTaskPhase` in the module (`:283`) and injects only `send` (`AnswerDeps`), leaving `saveRun` to
the caller (`src/supervisor/main.ts:218`). This PR inverts that: `StallDeps.escalate` is documented
as "Performs the ledger transition AND persists it, then sends" (`src/supervisor/stall.ts:221`), so
the ledger decision moves out of the module and into the wiring.

Three consequences, all verified:

1. **It is untested.** I replaced `src/supervisor/main.ts:264-265` with an unconditional
   `enterRunPhase(c.run, 'escalated', why)` — i.e. a task escalation would now park the whole *run*
   and lose the task's `escalated_from`. `bun test` still reported 389 pass / 0 fail and
   `tsc --noEmit` stayed silent. Reverted; `git status --porcelain` clean. Nothing in `test/` reaches
   this code, because `test/stall.test.ts:428` substitutes a fake `escalate` that only pushes a
   string. By contrast `deliverPendingAnswers`'s transition is exercised directly in
   `test/decide.test.ts`.
2. **`applyStalls` is only half-tested at the run level.** Every `applyStalls` test drives
   `taskStallCandidates`, so the `record = c.task ?? c.run` run branch at
   `src/supervisor/stall.ts:238` and `bumpStall(run, run, …)` are never executed either. That gap
   closes for free once the transition moves.
3. **It creates an undocumented ordering hazard.** `stallAwaiting` (`src/supervisor/main.ts:259`)
   and `from` (`:260`) *must* be captured before the transition at `:264`, because
   `enterTaskPhase` rewrites `task.phase` to `escalated` — whose row has `signal: 'manual'`
   (`src/lib/phases.ts:130`), so a later `stallAwaiting` would return "an answer to the open
   decision". The current order is correct, but nothing states the constraint and no test would
   catch a reordering.

**Fix inline, no behaviour change:** move the transition into `applyStalls`, next to the `bumpStall`
calls it already makes, and narrow `StallDeps.escalate` to the send (`(c, text-bag) => Promise<…>`)
— exactly the `deliverPendingAnswers` split. `applyStalls` already has `persist`. That makes the
run/task branch, the `why` string and the ordering unit-testable alongside the rest of the ladder,
and leaves `main.ts` as wiring, which is what it is everywhere else. This reverses no decision,
changes no scope, and needs no human judgment.

## MINOR 1 — the escalation send's result is discarded; every other send in this file inspects or logs it

`src/supervisor/main.ts:283` is `await herdr.agentPrompt(pane, text)` with the result dropped. Every
other send in the same file handles it: the delivery loop checks `sent.ok` and logs on give-up
(`:226-236`), and the probe two lines earlier returns its result so `applyStalls` can gate the bump
(`:256`, consumed at `src/supervisor/stall.ts:241`). `src/supervisor/tasks.ts:276-278` does the same
for answers. The adjacent failure mode here *is* logged — `:270-272` prints when there is no
orchestrator pane — so a send that is attempted and rejected is the one case that vanishes silently,
and it is the message telling the human they are needed.

The ledger-before-send ordering (`:262-263`) means nothing is lost — `hpipe status` still reports it,
per `src/lib/status.ts:21-27` — which is why this is MINOR rather than MAJOR. A `console.error` in
the same shape as `:234` closes it.

## MINOR 2 — two of the new `file:line` comment citations are already off by one, and the convention itself is new

`src/supervisor/stall.ts:230` cites "both `saveRun` sites in the tick
(`src/supervisor/main.ts:136`, `:217`)". The `saveRun` calls are at `src/supervisor/main.ts:137` and
`:218`; lines 136 and 217 are the comment line above the first and the `addPending` call above the
second. The other six citations added by this PR are exact — `src/supervisor/tick.ts:109`,
`src/cli.ts:304-320`, `src/lib/render.ts:8-14`, `src/lib/ledger.ts:48-62`, `src/cli.ts:298-299`
(twice), `src/cli.ts:292-302`, `src/cli.ts:315-317` — I checked each one.

Worth noting because the convention is introduced here: `git grep 'ts:[0-9]' 6008bce` over `src/`
and `test/` returns nothing, and the one pre-existing cross-file reference
(`src/lib/install-cli.ts:20`) names `src/cli.ts` with no line number. Line numbers in the same
package drift on the next edit — this one drifted inside its own PR. Either fix the two numbers or
name `saveRun` in `main()`'s tick without them, as the rest of the repo does.

## MINOR 3 — the only two files in the repo with consecutive blank lines are the two this PR touched

`src/supervisor/stall.ts:106-107` (two blank lines between `taskStallCandidates` and the
`stallStateFor` doc comment), and `test/stall.test.ts:69-71`, `:117-118`, `:143-145` (three, two and
three). I scanned every `.ts` file under `src/` and `test/`: no other file has a run of two or more.
Single blank line, as everywhere else.

## MINOR 4 — `STALL_PROBE_MAX` reaches the ladder through three separate parameters with nothing keeping them in step

`src/supervisor/main.ts` passes `config.STALL_PROBE_MAX` as `StallDeps.probeMax` (`:241`), again as
the last positional argument to `ladderFor` (`:254`), and again as the last positional argument to
`stallCandidates` (`:288`) and `taskStallCandidates` (`:292`). They decide, respectively, the
deferral bound, the sentence the agent reads, and whether the candidate's `action` is `escalate` —
so a mismatch produces a probe that promises a bound the code does not enforce. The friction is
already visible in the tests, which hand-synchronise `mkDeps`'s `probeMax: 3`
(`test/stall.test.ts:424`) against a literal `3` in each `taskStallCandidates(…, 45, 3)` call.

`candidateFor` already reads `probeMax` to compute `action` and `escalatable`; carrying it onto
`StallCandidate` alongside them would leave one source and let `ladderFor(c)` and the hold gate both
read it from the candidate.

---

Nothing else rose to a finding. `stallAwaiting`'s signal-keyed `if` chain reads cleanly and its
fall-through for a null artifact path is deliberate; `MS_PER_MINUTE` is a local improvement on the
bare `60_000` it replaces; `stall?: StallState` being the first optional field on `Run`/`Task`
(`src/lib/types.ts:95`, `:120`) is the honest type for a field added to an existing v2 ledger with no
migration, and `stallStateFor` treats absent and stale identically, so nothing reads `undefined` by
accident. The MAJOR and all four MINORs are inline fixes that change no behaviour and no decision.

VERDICT: CLEAR
