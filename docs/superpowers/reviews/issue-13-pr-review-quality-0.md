# PR #41 — stage 2 code-quality review (issue #13)

**PR:** #41 `fix: put the phase, age and next action in every digest line`
**Branch:** `fix/13-digest-content` — head `80ce63e428be7a427a39ab088b02372fb74b4b86`
**Scope of this pass:** code quality only. Intent was settled by
`docs/superpowers/reviews/issue-13-pr-review-intent-0.md` (CLEAR) and is not revisited.
**Yardsticks used:** `.claude/agents/plugin-dev.md`, `src/supervisor/stall.ts`,
`src/supervisor/tasks.ts`, `src/lib/status.ts`, `src/lib/gating.ts`, `src/lib/phases.ts`,
`test/table.test.ts`, `test/stall.test.ts`, and commit `0aa1dbf`.

## Method

File set re-derived from `gh pr view 41 --json files` (the local `main` ref is stale — a local
`git diff main...HEAD` replays #10/#39). Both gates run in the worktree. Three mutations probed
against a copy of the tree in a scratch directory outside the worktree; the worktree itself was not
modified apart from this file (`git status` clean, HEAD still `80ce63e`).

**Gates, reproduced:**

```
$ bun test          → 454 pass / 0 fail / 1072 expect() calls, 34 files
$ bun run typecheck → tsc --noEmit, no output, exit 0
```

CI is `pr-title-lint` + `release-please` only, so those two commands are the whole gate. The PR
title is conventional (`fix:`), which is what release-please parses.

---

## Findings

### MINOR 1 — the duplication rationale at `src/supervisor/tick.ts:9-13` names the far copy and not the near one

`src/supervisor/tick.ts:7` declares `const MS_PER_MINUTE = 60_000`. `src/supervisor/stall.ts:19`
already declares the identical constant, in the same directory, in the module `tick.ts` sits
beside — and `src/supervisor/stall.ts:70` is the second of the three minute-arithmetic copies the
spec's **A4** enumerates.

The doc comment justifies the third copy against only one of the two existing ones:

```ts
/**
 * Clamped, matching `src/lib/status.ts:12-14`. A third private copy of this
 * arithmetic is deliberate: sharing would mean exporting from `status.ts`, which
 * belongs to #14 and is being edited in the same batch.
 */
```

It says "a third private copy", so it knows there are three, but the reason it gives rules out only
`status.ts`. The obvious question from inside `src/supervisor/` — *why not
`import { MS_PER_MINUTE } from './stall'`?* — is unanswered by the code. The real answer is good and
short: `stall.ts` is outside this task's declared `--files` set and importing the constant would
mean exporting it from there, which §Non-goals bars ("**Touching `src/supervisor/stall.ts`**",
`docs/superpowers/specs/2026-09-17-issue-13-design.md:250`). A4 (`:640-650`) states all of this in
the spec; the comment does not, and the surface guide's rule is that the code's comments carry the
why.

This is a comment-accuracy nit, not a structural one: the *decision* is argued and settled and I am
not reopening it.

**Fix (inline):** extend the second sentence, e.g. `…belongs to #14, or exporting from
./stall.ts, which §Non-goals puts outside this task's file set.` One line, no behaviour change.

---

## What was checked and found sound

Recorded with evidence so a later pass does not re-derive it.

**The change mirrors its siblings rather than inventing a second way.**

- *Agent-facing text composed in TypeScript, keyed on the phase row.* `actionFor`
  (`src/supervisor/tick.ts:23-47`) branches on `taskRow(task.phase).actor` / `.terminal`, never on a
  hand-maintained phase list — the same shape as `stallAwaiting`
  (`src/supervisor/stall.ts:161-219`, keyed on `row.signal`) and `ladderFor` (`:226-233`), which is
  the model commit `0aa1dbf` established. Its signature `(run, task, hpipe)` is `stallAwaiting`'s
  signature verbatim.
- *`now` and `hpipe` injected, never read ambiently.* `ageMinutes(sinceMs, now)`, `describeWake(line,
  now, hpipe)`, `parkedFooter(run, covered, now, hpipe)` all take the clock as a parameter, matching
  `stallCandidates(runs, now, …)` (`src/supervisor/stall.ts:76`) rather than `src/lib/status.ts:12`,
  which reaches for `Date.now()` internally. `hpipe` arrives pre-rendered from `hpipeCommand`, which
  is the contract `src/lib/render.ts:16-27` documents and the reason `stallAwaiting` takes it too.
- *Text lives in the module that owns the concern.* `describeWake`/`parkedFooter` render wake lines
  in `tick.ts`, which owns wake lines; `buildDigest` still owns the envelope in `deliver.ts`. That
  is `stall.ts`'s split (it composes its own sentences and hands `deliver.ts` nothing), not a new
  arrangement.
- *Internal helper exported for a direct test.* `actionFor` and `ageMinutes` are exported and
  consumed only by `test/tick.test.ts`; `phaseBox` stays private. `stall.ts` does exactly this with
  `bumpStall`/`stallStateFor` (exported, used by `main.ts` not at all) while keeping `probePaneFor`,
  `actorPaneFor` and `candidateFor` private.
- *Hoisting `hpipeCommand` costs nothing.* `src/supervisor/main.ts:160` calls it once per tick,
  which is what the old placement in the stall block did. `hpipeCommand` does a `Bun.which` plus a
  `realpathSync` (`src/lib/render.ts:28-38`), so call count was worth checking; it is unchanged.

**Nothing was duplicated that the repo already has.** `filesOverlap` and `isInFlight` are imported
from `src/lib/gating.ts` rather than re-derived (`src/supervisor/tick.ts:2`). The one composite that
is restated — the "holder has stopped moving" test at `src/supervisor/tick.ts:39-43` against
`src/lib/status.ts:46-62` — is unavoidable here: `status.ts` is #14's file and outside this task's
`--files` set, and the comment at `:35-38` says which lines it mirrors and why. Same for the
`hpipe rewind` sentence at `:28-31` vs `src/lib/status.ts:21-27`; the divergence (injected CLI vs
the hardcoded `hpipe` literal) is deliberate, is pinned by *'actionFor renders the CLI it is given,
never a literal hpipe'*, and is handed to #14 as a latent defect rather than fixed across a file
boundary.

**Comments are why-only and match the house idiom.** Every comment added to `tick.ts` records a
constraint a reader could not recover from the code: why the `agent:` prefix is applied at push
(`:52-57`), why `phaseAtEvent` is captured before the forced `failed` (`:59-63`), why `escalated` is
spelled out rather than matched as `actor: 'human'` (`:112-113`), why rung 6 exists at all given
`ESCALATING_SIGNALS` (`:35-38`). Two carry `Measured on a live run.` with the measurement attached
(`:75-79`, `:97-102`), which is the convention `.claude/agents/plugin-dev.md` calls out. The same
holds in `main.ts:155-156` (why the tail gate moved off `task.agent_status`) and `:227-231` (why the
footer rides all three pendings). I found no comment that restates the line below it. The one that
comes closest, `src/supervisor/deliver.ts:25-26`, spends its first clause on the mechanism but its
second on the actual why — byte-identical output when there is no footer — and that claim is pinned
by a test.

**No dead or commented-out code.** The one unreachable branch —
`describeWake`'s `task === null` arm (`src/supervisor/tick.ts:83-86`) — is argued in the spec as
**A14** (`:775-778`), tabled in §Error handling (`:605`), labelled in the test itself, and has
direct repo precedent in `test/stall.test.ts:307-315`, which characterises `stallAwaiting`'s
unreachable fallback the same way. `prompts/digest.md` was deleted rather than left orphaned, and
`test/prompts.test.ts:21-24` reads the real directory, so re-adding it unwired goes red. No
reference to it survives anywhere in `src/`, `test/`, `prompts/`, `bin/`, `README.md` or
`herdr-plugin.toml`.

**Error handling matches the established shape.** The four new functions are pure and total over
every `TaskPhase`; the only throw reachable from them is `taskRow`'s
(`src/lib/phases.ts:145-149`), which is the repo's standard unknown-phase failure and is already
caught by the per-run `try` at `src/supervisor/main.ts:178/243`. Nothing new swallows an error,
and no new `console.error` shape was invented.

**The tests bite — probed, not assumed.** Three mutations on a scratch copy:

| Mutation | Result |
|---|---|
| Add `{ phase: 'awaiting-signoff', actor: 'human', signal: 'manual', onClear: 'done', holdsFiles: false }` to `TASK_ROWS` | **2 fail** — *'every row in TASK_ROWS gets a clause that matches who its actor is'* (`needs a human` vs `nothing for you — the supervisor is driving`) and *'the footer lists every non-terminal row a person has to act on'* (`awaiting-signoff: expected listed=true`) |
| Delete `.sort((a, b) => a.task_id.localeCompare(b.task_id))` from `src/supervisor/tick.ts:116` | **1 fail** — *'the footer names orchestrator-owned and escalated tasks that produced no line'* |
| (baseline) unmodified copy | 42 pass / 0 fail in `test/tick.test.ts` |

Both table-driven guards are keyed on what `actor`/`terminal` *mean*, deliberately not on the
implementation's own predicate — the comments at `test/tick.test.ts:526-531` and `:533-536` say so
explicitly, and the probe confirms they diverge where they are supposed to. That is the shape
`test/table.test.ts` already uses over `RUN_ROWS`/`TASK_ROWS`. This is the second version of these
guards; the first was a restatement of the implementation and was replaced in `a646554` after the
stage-1 review, and the replacement is materially stronger, not cosmetically different.

The rest of the new tests assert exact strings rather than `toContain` fragments where the output
*is* the product (`:418-423`, `:425-436`, `:438-450`, `:486-494`), reuse the file's existing
`mkTask`/`mkRun` helpers instead of adding a parallel fixture set, and each carries a one-line
comment naming the defect it exists for. `test/deliver.test.ts:348-351` pins the
byte-identical-without-a-footer claim directly rather than asserting around it.

**The source-text guard at `test/tick.test.ts:464-475` is the right call here, not a smell.** It
asserts `main.ts` declares `hpipe` exactly once and above its first use. `main()` runs only under
`import.meta.main`, so no test executes the tick body, and `tsc` does not flag a temporal-dead-zone
read from inside a loop — the comment says both. It bites as written:
`src.indexOf('describeWake(')` matches the call site at `:225`, not the import at `:20`. It lives in
a file that already imports from `../src/supervisor/main` (`:9`), so it is not reaching across a
boundary the file did not already cross. The repo has the pattern for source-text invariants
elsewhere (`test/prompts.test.ts:82-117` over `bin/hpipe`, `README.md`, `herdr-plugin.toml`); this
is its first use on a `.ts` file, which is a widening of the pattern but not a second way of doing
something the repo already does differently.

**Considered and deliberately not ranked:**

- *The footer excludes `blocked-on-files` even when rung 6 says the orchestrator must run
  `hpipe release`.* Real coherence gap between two functions in the same file, but the footer's
  membership predicate is specified verbatim at
  `docs/superpowers/specs/2026-09-17-issue-13-design.md:416-421` and the general parked-task problem
  is assigned to **#19** by the Scope ruling. Raising it would re-litigate a settled decision.
- *`covered` populated by a side effect inside `.map` (`src/supervisor/main.ts:220-226`).* I would
  write it as a separate `new Set(...)`, but this exact snippet is what the spec prescribes at
  `:543-548` and the plan at step 9. Style preference against a reviewed decision; not a finding.
- *`addPending` grown to six positional parameters with an `undefined` filler at `:237` and `:241`,
  and the `prompt.paneId === run.orchestrator_pane ? footer : undefined` ternary at `:238`
  re-deriving `isOrchestrator` that `deliveriesFor` already enforces.* The ternary is provably
  inert (`deliveriesFor` reads `footer` only inside its `first.isOrchestrator` branch,
  `src/supervisor/deliver.ts:70-77`, and grouping is by pane so the flag is uniform within a group).
  Stage 1 already checked and dismissed the equivalence, and the three-call-site wiring is the
  pass-2 MAJOR 2 fix the spec mandates at `:551-570`. Not worth a finding on its own.
- *`WakeLine.task` is never null at any of the three `wake.push` sites.* Tightening it would delete
  the defensive branch and one test — but **A14** declines the tightening on the record, names a
  plausible near-future need, and the repo already characterises an unreachable fallback the same
  way. Settled.
- *`src/supervisor/main.ts:158`'s "`hpipe` moves up from the stall block below; same call count"
  narrates the patch.* The repo's comments routinely reference history (`src/lib/phases.ts:36-38`,
  `src/supervisor/stall.ts:188-190`), and the sentence encodes a real why a reviewer would otherwise
  have to check. House style, not a defect.

---

One MINOR, a comment-accuracy nit with a one-line inline fix. Nothing reverses a decision, changes
scope, or needs a judgment only the human can make. The implementation tracks the reviewed spec and
plan closely — in several places verbatim — reuses the idioms of `stall.ts` and the phase table
rather than introducing a parallel mechanism, carries why-only comments in the repo's own voice, and
its new guards were verified to fail for the defect class they claim to catch.

VERDICT: CLEAR
