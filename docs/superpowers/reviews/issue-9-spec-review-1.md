# Adversarial review — spec for issue #9, pass 1

**Subject:** `docs/superpowers/specs/2026-09-17-issue-9-design.md` (v2, commit `e5fe3e7`)
**Against:** issue #9 (incl. its 2026-09-17 correction), `docs/superpowers/research/2026-09-17-issue-9-research.md`,
and `docs/superpowers/reviews/issue-9-spec-review-0.md` (`VERDICT: BLOCKER`, 1 blocker / 5 majors / 2 minors)
**Worktree:** `/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-9-artifact-paths` @ `e5fe3e7`
**Baseline re-verified:** `bun test` → `351 pass, 0 fail, 767 expect() calls, 33 files`; `bun run typecheck` clean.

## Audit of pass 0's dispositions — all six are genuine, none cosmetic or displaced

I re-derived each from the code and the real repos rather than from the disposition table.

- **BLOCKER 1 (mtime) — genuinely removed, not repaired.** The mechanism no longer reads a
  timestamp at any point. The `touch` refutation at spec lines 166-170 reproduces exactly in this
  worktree. More importantly, the three measured failures reproduce against berean-os at the shas
  the spec names, byte-for-byte:

      $ B=/Volumes/stein/Documents/development/personal/berean-os
      $ git -C $B diff --name-only --diff-filter=A main...f9085346 -- docs/
      docs/superpowers/notes/qr-display-removal.md
      $ git -C $B diff --name-only --diff-filter=A main...89147007 -- docs/
      docs/superpowers/notes/2026-09-16-atomic-store-saves.md
      $ git -C $B diff --name-only --diff-filter=A main...0c829e58 -- docs/
      docs/superpowers/notes/bookmark-save-reachability.md

  and `git -C $B log --all --find-renames --diff-filter=R --name-status -- docs/superpowers/`
  returns exactly the three corrective renames the research note claims and nothing else.
- **MAJOR 2 (`reviews/` exclusion) — load-bearing and correct.** Without it the design breaks on
  real data: every completed berean-os branch carries 3-5 verdict files under `docs/`, e.g.
  `git -C $B diff --name-only --diff-filter=A main...fix/30-launcher-wake-refresh -- docs/` returns
  8 paths, 5 of them `docs/superpowers/reviews/*`. With the exclusion and `claimed`, every one of
  those branches resolves to zero-or-one candidate in every artifact phase.
- **MAJOR 3 (`checkout_path` null) — applied as A7**, and A7's reachability argument checks out:
  `src/hooks/_hook.ts:56` sets `checkout_path` only under `if (raw.worktree?.path)`,
  `src/supervisor/tick.ts:40` stores `event.checkout_path ?? null`, and the `pane === null` guard is
  at `src/supervisor/tasks.ts:153`, driven by `pane_id` which arrives on a different event.
- **MAJOR 1 (fixture) — applied**, T1 now mandates `git init` + `git worktree add`;
  `worktreeWith` at `test/tasks.test.ts:247-252` is still the one-file `mkdtempSync` pass 0
  described, so the spec is right that it cannot be the primary fixture.
- **MAJOR 5 / MINOR 1 — picked and written down**, which is what pass 0's fix asked for
  (*"Pick one and write it down"*), and declining issue #9's first direction is sanctioned by the
  issue's own correction. Neither is a displaced fix. See MAJOR 3 below for the part of A9 that does
  not survive contact with `TICK_MS`.
- **MAJOR 4 — applied in outcome but its justification is false.** See MAJOR 2 below.

Citation accuracy is unusually high; I re-checked every line reference the spec adds in v2 and all
land: `src/supervisor/tasks.ts:202-210` (the exact `case 'research'` block), `:153`, `:165-167`,
`:92-95`, `src/supervisor/deliver.ts:89,90,93,97-101`, `src/supervisor/main.ts:160-163,217,241`,
`src/lib/config.ts:23,27,28`, `src/lib/machine.ts:125`, `src/lib/phases.ts:92-93`,
`src/cli.ts:87,88-92,191-192`, `src/supervisor/tick.ts:37,40,41`, `src/hooks/_hook.ts:56`,
`test/cli-commands.test.ts:159-176,304-319`, `test/tasks.test.ts:247-252`. `prompts/dispatch.md:8`
carries `--base main` and `prompts/worker-brief.md:63` carries *"Never commit to `main`"*, so A3's
premise holds.

The findings below are all internal-consistency defects in v2's own new text. None reverses a
decision or needs a human call.

---

## MAJOR 1 — the adoption scan is gated on `isFresh`, not on absence, so it also runs when the canonical artifact **exists but is stale** — which is every `onBlocker` re-entry into `spec` and `plan`

**Claim.** §C1 Wiring, line 203-205: *"The `if (!actorIdle) return base` guard stays first and is
load-bearing for cost: the `git diff` only ever runs against an idle worker whose canonical artifact
is absent."* A5 (line 323-325) rests the whole safety argument on fail-closed behaviour.

**Problem.** The guard the spec is wiring behind is `isFresh`, which returns `false` for a *stale*
file just as much as for a missing one — `src/lib/predicates.ts:10-20` is
`Math.floor(statSync(path).mtimeMs) > phaseEnteredAt` in a `try`, and the spec's own §Problem
(line 51-52) says so: *"a missing file is indistinguishable from a stale one."* Two lines later it
asserts the opposite.

This is not hypothetical, it is the revision loop. `spec-review` has `onBlocker: 'spec'`
(`src/lib/phases.ts:97`) and `plan-review` has `onBlocker: 'plan'`
(`src/lib/phases.ts:102-103`); `enterTaskPhase` re-stamps `task.phase_entered_at = Date.now()`
(`src/lib/machine.ts:94`). So on every returned review the canonical spec/plan file is present and
instantly stale, and from that tick onward — whenever the worker is idle and has not yet re-saved it
— the branch-diff scan runs.

Consequence: any doc the worker adds on the branch during a revision loop that is not under
`docs/superpowers/reviews/` and not already in `task.artifacts.{research,spec,plan}` is a lone
survivor, passes `isSettled` (it is a committed real file), and is **adopted as the spec**,
overwriting a `task.artifacts.spec` that was already correct. The phase then advances to
`spec-review` and `prompts/spec-review.md:21-22` hands the reviewer the wrong file. That is A5's
"wrong adoption is not recoverable" branch, reached through a door the design says is shut. This
spec's own history — a v1 rewritten into a v2 — is exactly the situation where a worker plausibly
writes a second document.

**Evidence.** `src/lib/predicates.ts:10-20`; `src/lib/phases.ts:97,102-103`;
`src/lib/machine.ts:94`; `src/supervisor/tasks.ts:208` (`if (!(await isFresh(absolute,
task.phase_entered_at))) return base` — the only gate between the idle check and where C1 inserts).
`src/lib/machine.ts:134` confirms `artifactFresh` alone advances an artifact row.

**Fix.** Gate adoption on *absence*, not on `!isFresh`: attempt `adoptableArtifact` only when the
canonical absolute path does not exist (`existsSync` / `await Bun.file(absolute).exists()`), and
keep `isFresh` as today's separate happy-path test. State it in A5 as the reason the design is
fail-closed on re-entry. Add a test case: `spec` re-entered from `spec-review` with the canonical
spec present-but-stale and one stray committed doc on the branch → **no** adoption.

---

## MAJOR 2 — C2's replacement sentence is falsified by C1 in exactly the cases C1 exists for, and the spec asserts twice that it is not

**Claim.** §C2, line 235: *"True before and after C1, and it does not mention recovery."* A10,
line 356: *"v2 keeps the firm register and **deletes only the sentence C1 makes untrue**."* The
sentence being shipped (line 233) is: *"An artifact written anywhere else does not complete the
phase."*

**Problem.** Post-C1, an artifact written anywhere else **does** complete the phase — that is the
Goal (line 84-87: *"advances anyway, whenever the branch identifies exactly one candidate"*) and the
worked case (line 265-270: worker writes `docs/superpowers/notes/qr-display-removal.md`, *"It is
adopted … the task advances to `spec`"*). The replacement is false on precisely the population C1
was built to serve, in the same way and for the same reason the deleted clause was. v1's own
standard, quoted approvingly in pass 0 and preserved in this spec's framing — *"a brief that is
wrong about the mechanism is worse than one that is merely firm"* — condemns the replacement as
readily as the original.

This is the one place where a pass-0 fix was adopted without being re-derived: pass 0 proposed this
wording and asserted its truth, and v2 carried both the wording and the unexamined assertion across.

**Evidence.** Spec lines 84-87, 233, 235, 265-270, 356. Live brief text at
`prompts/worker-brief.md:31-33` (*"the phase never completes"*, matching the spec's quotation).

**Fix.** Keep the wording — the 3/3-vs-3/6 argument for firmness is sound and MAJOR 4's outcome
should stand — but stop claiming it is true. Delete *"True before and after C1"* from §C2 and
rewrite A10 to own the choice: the brief deliberately states the contract the worker is held to, not
the recovery the supervisor performs, because advertising the fallback to the agent the fallback
exists to catch is what MAJOR 4 forbade. Alternatively, a wording that is both firm and true:
*"An artifact written anywhere else is not the path any later phase cites."*

---

## MAJOR 3 — the `console.error` trigger is specified two incompatible ways, and the §C1 version fires on **every tick of every `spec` and `plan` phase** on real data

**Claim.** Three mutually inconsistent statements of the same behaviour:

- §C1, line 206: *"On a miss with a **non-empty raw candidate list**, one `console.error` naming the
  count and the paths."*
- §Data and control flow step 6, line 260: *"**Two or more survivors** → `base`, plus one
  `console.error` …"*
- §Error handling, line 283: *"Two or more candidates | no adoption, keep waiting, one log line"*.

**Problem.** "Raw candidate list" is the `git diff` output at step 3, before the `reviews/` drop
(step 4) and before `claimed` (step 5). In any `spec` or `plan` phase the raw list is **never**
empty — the research note is always an added path on the branch. Verified on real data:

    $ git -C $B diff --name-only --diff-filter=A main...fix/51-adopt-orphaned-tmp -- docs/
    docs/superpowers/plans/2026-09-17-issue-51-plan.md
    docs/superpowers/research/2026-09-17-issue-51-research.md
    docs/superpowers/reviews/issue-51-spec-review-0.md
    docs/superpowers/specs/2026-09-17-issue-51-design.md

So under §C1's rule, the moment the task enters `spec` and the worker is idle with the canonical
spec not yet written — the normal first seconds of every spec and plan phase — the supervisor logs
an error about a candidate set that is, correctly, empty after filtering. Step 6's rule does not.
An implementer reading §C1 and an implementer reading §flow write different code, and one of them
is a permanent false alarm.

Second, neither rule is deduplicated, and `TICK_MS` is `1000` (`src/lib/config.ts:23`). The line
repeats once per second for as long as the condition holds — which, for the genuine ≥2 case, is
until a human intervenes; `TASK_STALL_MINUTES` is `45` (`src/lib/config.ts:27`), so ~2700 identical
lines before the first probe. A1 (lines 296-298) rejects the whole "keep the plugin's path
authoritative and report loudly" alternative on the grounds that *"Reporting needs per-phase-entry
dedup state to avoid re-prompting on a 1s tick"* — and then C1 introduces undeduped per-tick
reporting anyway. A9 makes that log line the entire answer to pass 0's MAJOR 5, so it is not
decoration.

**Evidence.** Spec lines 206, 260, 283, 296-298; `src/lib/config.ts:23,27`; berean-os branch diffs
above; `src/supervisor/main.ts:160-163` (the cited precedent is a *per-delivery* line, not a
per-tick one, so it is not precedent for an unbounded repeat).

**Fix.** Pick step 6's rule — log only when **two or more survivors remain after filtering** — and
delete the "non-empty raw candidate list" phrasing from §C1. Dedup it per phase entry with a
module-level `Set<string>` keyed by `${task.task_id}:${task.phase}:${task.phase_entered_at}` in
`src/supervisor/tasks.ts` (in the file set, no `Task` field, so A1's objection does not apply to a
log line), and say so, so the spec stops contradicting A1. Extend T3 to assert the line fires
**once** across multiple ticks.

---

## MINOR 1 — the `git diff` output is consumed as machine data but nothing pins `core.quotePath` or rename detection

**Claim.** §C1 step 3: *"`git -C <checkoutPath> diff --name-only --diff-filter=A main...HEAD -- docs/`"*,
step 6: *"return it (a repo-relative path, which is what `task.artifacts` stores)"*.

**Problem.** Two ambient-config dependencies, both verified in a scratch repo:

    $ git diff --name-only --diff-filter=A main...HEAD -- docs/
    "docs/superpowers/notes/caf\303\251-se\303\261or.md"
    $ git -c core.quotePath=false diff --name-only --diff-filter=A main...HEAD -- docs/
    docs/superpowers/notes/café-señor.md

A non-ASCII filename comes back C-quoted and octal-escaped, quotes included. That string would be
the "exactly one survivor"; `isSettled` then fails on it and the feature silently does nothing for
any repo whose docs carry an accent — a fail-closed outcome, but an invisible one.

Rename detection is the second, and it fails *open*. The design implicitly relies on `git mv` of a
pre-existing doc showing as `R`, not `A`:

    $ git -c diff.renames=false diff --name-only --diff-filter=A main...HEAD -- docs/
    "docs/superpowers/notes/caf\303\251-se\303\261or.md"
    docs/superpowers/research/moved.md      # ← the moved pre-existing file, now an "Added" candidate

With `diff.renames=false` in a user's gitconfig, a worker that reorganises `docs/` produces a
spurious lone candidate that is a real settled file and gets adopted — A5's unrecoverable branch,
reached from a config the design never mentions.

**Fix.** Spell the command as machine-facing: `git -c core.quotePath=false -c diff.renames=true -C
<checkoutPath> diff -z --name-only --diff-filter=A main...HEAD -- docs/`, split on `NUL`, and add a
sentence to A2 stating that rename detection is what keeps a reorganised doc out of the candidate
set.

## MINOR 2 — the test files the plan will edit are not in the declared file set

§Testing strategy edits `test/tasks.test.ts` (T1-T10) and `test/cli-commands.test.ts` (C2), but the
declared file set (spec lines 8-9, matching `t1.files` in the live ledger) is
`src/cli.ts`, `src/lib/worker-prompt.ts`, `src/supervisor/tasks.ts`, `src/supervisor/deliver.ts`,
`prompts/worker-brief.md` — source and a prompt, so the convention is evidently not "src only".
The overlap gate is real (`blocked-on-files` → `filesClear`, `src/lib/machine.ts:186-187`,
`src/lib/phases.ts:105-106`) even though it is orchestrator-adjudicated rather than computed. Risk
here is low — `t2`'s files are `stall.ts`, `main.ts`, `stall-probe.md`, `status.ts` — but the spec
should either name the two test files as expected edits outside the declared set, or say that test
files are conventionally excluded from `files` in this repo.

**Fix.** One sentence under §Testing strategy naming the two test files and the fact that they sit
outside `t1.files`.

---

None of the three MAJORs reverses a decision, changes scope, or needs a call only the human can
make: MAJOR 1 is a one-predicate change plus a test, MAJOR 2 is a correction to two sentences of
justification that leaves the shipped wording intact, MAJOR 3 is choosing between two rules the
spec already wrote. The load-bearing mechanism is sound and, unlike v1's, verified against the
actual failures it claims to fix.

VERDICT: CLEAR
MAJORS: 3
