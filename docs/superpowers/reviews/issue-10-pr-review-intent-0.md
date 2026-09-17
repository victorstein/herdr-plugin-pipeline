# PR review 0 (intent) — issue #10, PR #39 (`--files` validation and echo)

Reviewed `gh pr diff 39` at `7fd8423` on `fix/10-files-validation` against `gh issue view 10`
(including the ownership ruling appended 2026-09-17),
`docs/superpowers/specs/2026-09-17-issue-10-design.md`,
`docs/superpowers/plans/2026-09-17-issue-10-plan.md`, and `.claude/agents/plugin-dev.md`.

Scope of this review is intent only: does the PR do what was asked, completely, and nothing else.
Code quality is stage 2 and no style, naming or structure finding appears below.

Every mechanical claim was re-measured in this worktree rather than taken from the PR body.

## Verification I ran

- `bun run typecheck` → `tsc --noEmit`, no output, exit 0.
- `bun test` → **427 pass, 0 fail, 945 expect() calls, 34 files**. Matches the PR body and the plan's
  test-count ledger (`plan:827-838`) exactly.
- `ls ~/.local/state/herdr/plugins/stein.pipeline/runs/` → `personal`, `pipeline`. **No
  `argv-fixture` session directory**, so `test/cli-argv.test.ts` did not leak into the live ledger on
  the run I just did, which is the hazard A12 (`spec:375-384`) and the plan's Step 6 warning
  (`plan:443-449`) exist to prevent. The pinning is real: `src/cli.ts:391-393` reads
  `HERDR_PLUGIN_STATE_DIR` and `HERDR_PLUGIN_ROOT`, `src/lib/session.ts:6-7` prefers
  `HERDR_SESSION`, and `test/cli-argv.test.ts:28-33` sets all four.
- `fail()` really is a stdout-plus-exit-1 channel: `src/cli.ts:478-479`
  (`console.log(out.text); return out.ok ? 0 : 1`), so the runbook's "exit 1" expectation and the
  argv tests' `code === 1` assertions are testing the operator-visible thing.

## Issue acceptance criteria — all three met

The issue's §Directions has exactly three bullets.

1. **"Echo what was recorded on success: `files: src/foo, src/bar` (or `files: none`) alongside
   `task_id:`."** Met on both success returns: `src/cli.ts:143` (gated) and `src/cli.ts:152`
   (dispatched), from one shared `filesLine` at `src/cli.ts:139`. I confirmed `cmdTask` has exactly
   two `ok(` returns (`grep -n "task_id:" src/cli.ts` → `:100` the literal, `:143`, `:152`), so
   "every success path" is literally satisfied, not just the two the spec named.
2. **"Reject a `--files` entry containing whitespace, or accept repeated `--files` flags /
   whitespace as a separator."** The PR takes the reject branch (`src/cli.ts:76-94`) *and* the
   repeated-flag branch (`src/cli.ts:366-379`). Doing both is not scope expansion — A3
   (`spec:305-309`) argues the accumulation is load-bearing for the rejection, since "repeat the
   flag" is the obvious retry and it silently dropped everything after the first.
3. **"Name the separator in the prompts and the README."** `prompts/intake.md:24`,
   `prompts/dispatch.md:33`, `README.md:80` all now read `[--depends-on <id,id>]
   [--files <prefix,prefix>]`.

The issue's root-cause framing ("the absence of feedback, not the separator") is answered in the
right order: `src/cli.ts:76-94` sits after the `--surface` check and **before** the task literal at
`src/cli.ts:99`, so a rejection mints nothing. `test/cli.test.ts:182-183` asserts exactly that —
`after?.tasks` is `[]` and a pre-set `intake_closed: true` is untouched — which is the assertion that
distinguishes "rejected before `run.tasks.push`" from "rejected before the prompt was returned".

**Ownership ruling.** "#10: take the file. Fix the §2 assertion you invalidate, and add the
malformed-`--files` rejection if your plan keeps it." Both done
(`test/integration/smoke.md:91-107` and `:120-124`), and the ruling's counterpart instruction — leave
the digest prose alone — is honoured: the baseline `:164-165` prose is now at
`test/integration/smoke.md:186-187` after 8a's insertion and is untouched by the diff (the file has
exactly two hunks, at `@@ -88` and `@@ -97`).

## Spec requirements — C1 through C5 all implemented

| Component | Where | Held |
|---|---|---|
| C1 rule 1, whitespace (`spec:141`) | `src/cli.ts:82-87` | yes, message and `→` suggestion verbatim to `spec:147-148` |
| C1 rule 2, flag-shaped (`spec:142`) | `src/cli.ts:88-93` | yes, verbatim to `spec:150` |
| C2 echo, both returns (`spec:154-174`) | `src/cli.ts:139,143,152` | yes, `files: none` for the empty case |
| C3 accumulation, `flag` unchanged (`spec:176-181`) | `src/cli.ts:366-379`; `flag` still `indexOf` at `:361-364` | yes |
| C4, six documentation edits (`spec:187-194`) | see below | yes, all six, plus the review-1 MINOR 4 addition |
| C5a, subprocess argv proof (`spec:222-239`) | `test/cli-argv.test.ts` | yes, five tests not four |
| C5b, runbook as live proof (`spec:241-244`) | `test/integration/smoke.md:91-107` | yes |

C4's six rows all landed: `prompts/intake.md:24`, `prompts/intake.md:28-32` (the load-bearing passage
that tells the orchestrator what `hpipe task` prints), `prompts/dispatch.md:33`, `README.md:80`,
`test/integration/smoke.md:120-124` (the invalidated assertion, now naming `files: src/lib` and
`files: src/lib/config.ts`), and `test/integration/smoke.md:91-107` (the rejection step). The seventh
edit — the `prompts/dispatch.md:26-28` handover paragraph — is spec-review-1's MINOR 4 folded in at
`plan:610-634`, so it is declared work, not creep.

The `test/prompts.test.ts` guards C4 had to clear all pass: the new prompt prose writes
`` `{{hpipe}} task` `` and contains no literal `hpipe`, `worktree create --cwd {{repo_root}}` is
intact, and the four README strings are undisturbed — all confirmed by the green suite rather than by
reading.

**Goal 5 ("proven through the argv path") is genuinely satisfied, not restated.**
`test/cli-argv.test.ts` spawns the real `src/cli.ts` and asserts on real stdout and real exit codes
for all five shapes: comma-split, repeated flag, space-separated rejection, valueless `--files`
swallowing `--surface`, and no flag at all. The fourth (`test/cli-argv.test.ts:80-90`) is the one
only argv can produce, added per spec-review-1 MAJOR 1, and it asserts the thing that made the bug
invisible — `not.toContain('no agent definition')`, i.e. `--surface` still resolved to `core` while
`--files` was poisoned. `test/cli-argv.test.ts:59` asserts the *scratch* state dir received the run,
which is both the safety check and proof the subprocess wrote where the test thinks it did. These are
behavioural tests, not implementation restatements: none of them imports or names an internal, and
all five fail against pre-change `src/cli.ts` because none of the asserted strings existed.

The `listFlag` unit tests (`test/cli.test.ts:142-156`) do touch a newly exported internal, but that
export is A5 (`spec:319-325`), argued against moving the helper to `src/lib/` because
`.claude/agents/plugin-dev.md` assigns argv parsing to `src/cli.ts`. I re-read that guide and it does
say exactly that; thirteen `cmd*` functions are already exported for the same reason.

## Non-goals — all respected

`git diff --stat main...HEAD` touches 13 files. `src/lib/gating.ts`, `src/lib/status.ts`,
`src/lib/types.ts`, `src/lib/phases.ts`, `src/supervisor/tick.ts`, `src/supervisor/deliver.ts` and
`prompts/digest.md` are **all absent** — so the "no change to the gate", "no change to any read-back
command", "no schema change" and "sibling boundary" non-goals (`spec:99-125`) hold mechanically, and
the PR's "runs already on disk are unaffected" claim is true by inspection. No path-existence check
was added. No ledger migration was attempted.

## Divergence from the plan

I diffed the plan's specified code against what landed, step by step. `src/cli.ts` matches
`plan:108-123`, `plan:271-291`, `plan:353-363` and `plan:421` character-for-character. The only
departures are two doc-comment rewordings in `test/cli-argv.test.ts` and
`test/integration/smoke.md` that make a committed file less pane-specific, plus the plan's own
predicted `TS2305` being `TS2459` in practice — which the PR body discloses under §Notes for review.
Nothing undisclosed.

---

## MINOR 1 — the runbook's new recovery clause sends the operator to the wrong section, which the `abort` it just told them to run makes unreachable

`test/integration/smoke.md:104-107`:

    **Failure looks like:** the command succeeding and printing `task_id: t1`. … Run
    `hpipe abort <run_id>`, restart from §2, and report it.

The new step sits inside **§1** (`test/integration/smoke.md:70`, `## 1. Start, intake, dispatch`), not
§2. `§2` is `## 2. Two workers at `spec` simultaneously` (`:158`), which presupposes two registered,
dispatched tasks already driving toward `spec`.

That matters because of what `abort` does: `cmdAbort` (`src/cli.ts:318-328`) sets `run.phase = 'done'`,
and `cmdTask` refuses any run that is not in `intake`, `dispatch` or `execute` (`src/cli.ts:57-61`).
After the abort there is no registerable run, so the only correct restart point is §1's
`hpipe start` at `:75`. Either reading of the reference — the literal §2, or "the registration
section" as the spec and plan both mislabel it (`spec:120`, `spec:193-194`, `plan:656`) — leaves the
instruction unfollowable.

Two adjacent claims in the same edit are correct and I re-checked both, so this is a single wrong
cross-reference and not a pattern: §3 (`:204-239`) does name `t1` and `t2` literally, at `:212` and in the asserted `status` line at
`:217`, so `:106` and `:124` are accurate.

This is inherited verbatim from `plan:698`, so it is not an unexplained divergence from the plan —
the plan says it too. It is still a shipped defect in a hand-run runbook, in the branch a human
reaches precisely when the feature is broken.

**Fix.** `test/integration/smoke.md:107` → "Run `hpipe abort <run_id>`, restart this section from
`hpipe start`, and report it."

---

Counts: 0 BLOCKERs, 0 MAJORs, 1 MINOR.

Every acceptance criterion in issue #10 is met, every one of the spec's five components is
implemented rather than half of them, both halves of the ownership ruling are honoured, and the
argv-layer proof the spec made mandatory in pass 1 exists and bites. The suite and typecheck reproduce
the PR body's numbers exactly, and the live ledger shows the subprocess fixture stayed in its scratch
directory. The single finding is a wrong section reference in a failure-recovery sentence, fixable in
place without touching a decision, the scope the ruling fixed, or anything only the human can call.

VERDICT: CLEAR
