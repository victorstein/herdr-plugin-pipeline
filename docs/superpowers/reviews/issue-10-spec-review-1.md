# Spec review 1 — issue #10 (`--files` validation and echo)

Reviewed `docs/superpowers/specs/2026-09-17-issue-10-design.md` at `525d557` against `gh issue view 10`
(including the Ownership ruling appended after pass 0), the research note,
`docs/superpowers/reviews/issue-10-spec-review-0.md`, the code in this worktree, the live ledger, the
sibling issues, and `fix/13-digest-content`'s own spec.

## The eight pass-0 findings: all applied, all verified

I re-derived each one rather than taking the "What changed from pass 0" section's word for it.

| Pass-0 finding | Status | What I checked |
|---|---|---|
| BLOCKER 1 — `smoke.md` owned by neither task | **Really fixed.** Escalated as `d1`, ruled to #10. The ruling text is in `gh issue view 10` §Ownership ruling and verbatim in `gh issue view 13`. #13's spec records it in its own Non-goals and declares it will not touch the file (`git show fix/13-digest-content:docs/superpowers/specs/2026-09-17-issue-13-design.md`, §Non-goals "Editing `test/integration/smoke.md`…"). | Both sides of the ruling are live, not just #10's side. |
| MAJOR 1 — #23 owns no part of the durable-state gap | **Really fixed.** `gh issue view 23` body contains no `files`; its scope sentence is the artifact case. `gh issue view 17` does name `files` in `hpipe show --task <id>` and cites this bug. #37's third direction is verbatim "surface it in `hpipe status` as a warning". A9 (spec:346-354) and the non-goal (spec:102-109) now hand off to #17/#37 and keep #23 only as shape precedent. | The two cited issues really do own the two halves. |
| MAJOR 2 — `test/prompts.test.ts` survey was a misread | **Really fixed, and the spec is right where review 0 was wrong.** `wc -l` → 148; `grep -c "test("` → **16** (review 0 said 18; the spec's 16 is correct). `:68-76` is the literal-`hpipe` guard over `ALL` (`:10-14`, contains `intake` and `dispatch`); `:60-66` is the `--cwd {{repo_root}}` assertion; `:88-100` are the four pinned README strings, none of which is line 80. C4 now carries all three constraints (spec:199-213). `test/integration/smoke.md` is indeed not in `ALL`. | Every guard enumerated, and the count corrected against the reviewer. |
| MAJOR 3 — unit tests cannot cover C3 | **Really fixed.** The "the unit tests do cover the behaviour" sentence is gone from the Testing strategy. `grep -n "^export" src/cli.ts` → 13 `cmd*` + 2 interfaces; `flag` (335), `listFlag` (340), `dispatch` (353) are private; the sole `--files` argv site is `src/cli.ts:386`; `grep -rn "listFlag" test/` returns nothing. C5 takes **both** remedies, and A11 argues why. | See MAJOR 1 below for the one hole left in C5a. |
| MINOR 1 — churn premise | Clause gone. `git show --stat 93f79b2 -- src/lib/status.ts` → `1 file changed, 19 insertions(+)`, an addition. (Offset is off by one — MINOR 2 below.) |
| MINOR 2 — "fourteen" | `grep -c "^export async function cmd" src/cli.ts` → `13`. Spec says thirteen. Fixed. |
| MINOR 3 — runbook edit in scope or not | C4 (spec:193-194) now lists the `:100` repair and the `:92-93` rejection as two separate committed rows, and the Testing strategy no longer defers either. Fixed. |
| MINOR 4 — `--depends-on` left undocumented | All three doc rows now read `[--depends-on <id,id>] [--files <prefix,prefix>]` (spec:189-192). Fixed. |

**Mechanical surface re-verified, independently of review 0.** `cmdTask` is `src/cli.ts:53-127`; the
`--surface` check ends at `:74` and `const date` is `:76`, so C1's insertion point exists as
described; the two success returns are `:117` and `:126`; `--depends-on` checks are `:104` and
`:107`; `fail()` reaches stdout and exit 1 at `:441-442`; `src/cli.ts:215` is the `released …; files
reservation cleared` precedent; `task.files` is `string[]` at `src/lib/types.ts:66`;
`gating.ts:15-21`, `:49-53`, `:60-71` and `status.ts:46-63` are where the spec says (the last still
guarded by `if (task.phase === 'blocked-on-files')`). Doc line numbers are exact:
`prompts/intake.md:24` and `:27-29`, `prompts/dispatch.md:31`, `README.md:80`,
`test/integration/smoke.md:92-93` and `:100`, and the digest prose the ruling defers really is at
`smoke.md:164-165`. `renderWorkerPrompt` (`src/lib/worker-prompt.ts:10-36`) shells out to nothing, so
C5a's subprocess is feasible with no `gh` and no network. A12's environment claim is correct as
measured: this pane carries `HERDR_SESSION=pipeline` and
`HERDR_SOCKET_PATH=…/sessions/pipeline/herdr.sock`, and `HERDR_PLUGIN_STATE_DIR` is **unset**, so an
unpinned subprocess would fall through `src/cli.ts:354-355` onto the live ledger exactly as A12
warns. Baseline reproduces at `525d557`: `bun test` → 414 pass / 0 fail / 33 files;
`bun run typecheck` → clean, exit 0. CI really is a PR-title lint plus release-please-on-`main`
(`.github/workflows/`), so nothing runs `bun test` on the PR.

**A13 checked empirically rather than taken on trust.** A13 asserts #13 "has no reason to touch a
`cli` test". #13's spec declares its test edits as `test/tick.test.ts`, `test/prompts.test.ts:12`,
`test/stall.test.ts:307-315` and `src/supervisor/main.ts` (its own A11), plus `test/deliver.test.ts`
as must-stay-green. No `test/cli*.test.ts`. The distinction A13 draws holds on the evidence, and
neither candidate landing site for C5a collides with #13.

A1, A2, A4, A6, A7, A8, A10, A11, A12 and the four Rejected alternatives are argued honestly and I
would not overturn any of them. The two findings below are about C5a's coverage and one committed
runbook edit.

---

## MAJOR 1 — Goal 5 promises the argv path proves every rule, and C5a never exercises the one rule that *only* argv can produce

**Claim.** Goal 5 (spec:91-92): "All four are proven **through the argv path an operator actually
types**, not only against the exported function." C5a is the mechanism (spec:215-239), and the
Testing strategy calls it "the four subprocess invocations tabulated above" (spec:418).

**Problem.** C1 has two rules, and C5a covers one of them. The missing one is the `--`-prefix rule,
and the spec itself says it is "**only reachable from a valueless `--files`**" (spec:142) — i.e. its
only real-world origin is an argv accident. The only test for it is unit test 3 (spec:407-408),
which hands `cmdTask` `files: ['--surface']` directly — a value the exported function can be *given*
but which the real parser produces only through the path C5a does not run. So the rule whose
existence is justified entirely by argv behaviour is the one rule with no argv-level coverage, which
is the same shape as MAJOR 3's complaint: proving the helper is not proving the wiring.

This also matters for the *silent* half of the bug. The research measured that
`--files --surface core` records `["--surface"]` **and still resolves `--surface` to `core`**,
because `flag` re-scans argv independently (`src/cli.ts:335-338`) — that is why the accident is
invisible today. A subprocess invocation is the only thing that can assert both halves at once: the
rejection fires, *and* the command was otherwise well-formed. The spec's own Error-handling table
commits to the outcome (`spec:275`: "`--files --surface core` … **C1 rejects**, exit 1") without
proving it anywhere the real parser runs.

Separately, Goal 5's "all four" is literally false for Goal 4, which is a documentation change and
cannot be proven through argv at all.

**Evidence.**

- C5a's table, spec:231-235, in full: `--files src/a.ts,src/b.ts`; `--files src/a.ts --files
  src/b.ts`; `--files "src/a.ts src/b.ts"`; no `--files`. The flag-shaped case is absent.
- spec:142 — the rule's stated reachability. spec:150 — its message.
- spec:407-408 — the only test for it, at the exported-function layer.
- `src/cli.ts:335-338` is `indexOf`-based and is re-entered per flag name, which is what makes
  `--files --surface core` resolve `--surface` correctly while poisoning `files`:

      function flag(argv: string[], name: string): string | null {
        const i = argv.indexOf(`--${name}`)
        return i === -1 ? null : (argv[i + 1] ?? null)
      }

- `.claude/agents/plugin-dev.md:53-59` ("Where the behaviour is actually proven") is the reason the
  spec made C5a mandatory in the first place; the gap re-opens it for one of the two rules.

**Concrete fix.** Add a fifth row to C5a: `--files --surface core` (with a valid `--branch`,
`--issue`, and a `core-dev.md` in the fixture) must exit 1 with the flag-shaped message, and the
assertion should note that `--surface` itself was well-formed — that is the measured silence this
rule exists to break. Reword Goal 5 to name what the argv path proves (goals 1–3), and say
separately that goal 4 is proven by reading the three documents plus `bun test`'s prompt guards.

---

## MAJOR 2 — C4 commits a deliberately-failing `hpipe task` into §2 of the runbook, in a block the runbook says the orchestrator types, with no stated recovery — and its failure mode is unrecoverable

**Claim.** C4's sixth edit (spec:194): "`test/integration/smoke.md` | 92-93 | add the malformed
invocation as an expected rejection, per the ruling's 'add the malformed-`--files` rejection if your
plan keeps it' — a space-separated value must print the C1 message and exit 1 before either task is
minted."

**Problem.** Two things, both concrete.

*Placement.* `test/integration/smoke.md:87-89` reads "Now let the orchestrator do intake for real:
it files **two** GitHub issues, one per task, and registers both." Lines 91-94 are the fenced block
that documents what *the orchestrator agent* will run. A step that requires a human to type a
knowingly malformed command does not belong inside a block describing an autonomous agent's
invocations; nothing in §2 tells the operator who runs the new line or when.

*Failure mode.* If the rejection does **not** fire — which is the only reason to run the step — the
malformed invocation mints a task, and the spec's own Error-handling section states the consequence:
"there is no command that removes a task once minted" (spec:281-284). A ghost task placed before the
two real registrations renumbers them to `t2`/`t3`, and §3's assertions name the ids literally:

    smoke.md:191  1. Exactly one of `t1`/`t2` leaves `blocked-on-files` for `implement`. … `t1` should win
    smoke.md:197       ⚠ t2 blocked on files held by t1 (implement) — `hpipe release --task t1` is the only way out

A ghost placed after them mints `t3` with a whitespace-bearing entry that no sibling can
prefix-match, which also perturbs `releasableFromFiles`'s "at most one release per overlapping
group" (`src/lib/gating.ts:60-71`) that §3 exists to observe. Either way the only escape is
`hpipe abort <run_id>` and a restart of the whole live smoke run. The runbook's own house style
states this kind of thing — every other section carries a "**Failure looks like:**" paragraph
(`smoke.md:112`, `:209-212`) — and this edit carries none.

**Evidence.** `sed -n '87,103p' test/integration/smoke.md` gives the prose at 87-89, the fence at 91,
the two commands at 92-93, the close at 94 and the `**Observe:**` assertion at 100. §3 is
`smoke.md:183-212`; its assertion 1 is at `:191` and the quoted `⚠` line at `:197`. `cmdAbort`
(`src/cli.ts:292`) aborts a run; there is no per-task removal — `cmdRelease` (`src/cli.ts:201-217`)
only clears `task.files`.

**Concrete fix.** Lift the rejection out of the orchestrator's fenced block and give it its own
labelled step ahead of the two real registrations — the operator runs it by hand, expecting exit 1 —
with an explicit failure clause: *if this mints a task instead of failing, that is the finding;
`hpipe abort <run_id>` and restart §2, because no command removes a task.* Then state that §2's two
registrations must still produce `t1` and `t2` for §3 to mean anything.

---

## MINOR 1 — the `task_id:` grep that clears the echo is not what that grep returns

spec:261-263 says `grep -rn "task_id:" src/ prompts/ test/ bin/` "returns only the two producers in
`src/cli.ts`, unrelated `history` writes, `toContain` assertions in `test/cli.test.ts:58-62`, and
the runbook prose at `test/integration/smoke.md:100`". Run here it returns roughly ninety lines,
most of them `task_id: 't1'` object literals in test fixtures (`test/gating.test.ts`,
`test/status.test.ts`, `test/decide.test.ts`, `test/tasks.test.ts`, …), plus
`src/lib/types.ts:61` (the field), `src/lib/worker-prompt.ts:17` (the `{{task_id}}` render variable),
`src/lib/machine.ts:91` and `src/supervisor/tasks.ts:359`. The **conclusion** holds — none of those
is a positional parse of `cmdTask`'s stdout, and the only assertions are `toContain` — but the stated
evidence is not reproducible as written, and this is the one paragraph that licenses inserting a line
into two success returns. Fix: state the filter actually applied (e.g. `grep -rn 'task_id: \$\|task_id: t'`,
or "excluding object-literal fixture hits") and keep the conclusion.

## MINOR 2 — "at `HEAD~5`" is off by one against the spec's own anchor

spec:48-49 gives `93f79b2` "at `HEAD~5`". The spec declares itself written at `f8b9a67` (spec:3), and
`git log --oneline f8b9a67 -8` puts `93f79b2` six back: `f8b9a67, a4fffdf, 6c75122, 343dde4, 0aa1dbf,
ff99f40, 93f79b2`. `HEAD~5` was correct in review 0, whose anchor was `a4fffdf`; the number was
carried across without re-anchoring. The substance (an addition, 19 insertions, not a rewrite) is
right. Fix: `f8b9a67~6`, or drop the offset and keep the sha.

Same shape, same cause, one line elsewhere: spec:41 cites `dispatch` as "module-private
(`src/cli.ts:355`)", carried from review 0. `grep -n "async function dispatch" src/cli.ts` → `353`;
`:355` is the `HOME` fallback inside it. Harmless, but it is the second number in this pass that was
re-used rather than re-measured.

## MINOR 3 — A12 pins three of the six environment inputs `dispatch` reads, and C5a's fixture is not cleaned up

A12 (spec:375-384) names `HERDR_PLUGIN_STATE_DIR`, `HERDR_SESSION` and `HERDR_SOCKET_PATH`.
`dispatch` also reads `HOME` (`src/cli.ts:355`, moot once the state dir is pinned),
**`HERDR_PLUGIN_ROOT` (`src/cli.ts:356`)**, and `HERDR_PANE_ID` / `HERDR_WORKSPACE_ID`
(`:374-375`, harmless because they land in the scratch state dir). `HERDR_PLUGIN_ROOT` is the one
that matters: inherited, it makes the subprocess render prompts from the *installed* v1.2.1 plugin
root rather than this checkout, so a C5a assertion on the dispatched path could fail or pass for the
wrong reason. It is unset in this pane today, which is exactly why it will be missed. Separately,
`tempDir()` registers into a module-level list that only `cleanupFixtures()` drains
(`test/helpers/git-worktree.ts:5-16, 48-51`, "none of it is self-cleaning"), and C5a's steps
(spec:225-227) do not mention it; and the table at spec:231-235 states `cwd` only for the `start`
invocation, though `needsRepo` covers `task` too (`src/cli.ts:360-363`) and a missing `cwd` yields
`hpipe: not inside a git repository` rather than the asserted stdout. Fix: add `HERDR_PLUGIN_ROOT`
to the pinned list, say `cwd` applies to all five invocations, and name `cleanupFixtures()` in an
`afterAll`.

## MINOR 4 — `prompts/dispatch.md` documents the same command and the same handover, and C4 updates only its usage line

spec:196-197 calls `prompts/intake.md:27-29` "the passage that tells the orchestrator what
`hpipe task` prints". It is not the only one that depends on that shape. `prompts/dispatch.md:28-32`
documents `{{hpipe}} task` for tasks registered *after* intake closes — the post-intake registration
path — and `:23-26` instructs "Hand the worker the brief **exactly as you were given it** … Do not
summarise it, do not add task text of your own", against a blob that after C2 carries two header
lines (`task_id:` then `files:`) instead of one. C4 edits `dispatch.md:31` and nothing else, so the
prompt that governs the orchestrator at the moment it is handing a brief to `herdr agent start`
still describes a one-line preamble. Harm is bounded — the orchestrator already had to separate
`task_id:` from the brief — but the line is being retyped anyway. Fix: extend the `dispatch.md`
edit by one sentence naming the `files:` line, the same way C4 extends `intake.md:27-29`.

---

Neither MAJOR reverses a decision, changes the scope the ownership ruling fixed, or needs a call only
the human can make: MAJOR 1 adds one row to a test table the spec already commits to, and MAJOR 2
relocates and annotates an edit inside a file #10 already owns under the ruling. Both, and the four
MINORs, are inline fixes for the plan phase. Counts: 0 BLOCKERs, 2 MAJORs, 4 MINORs.

VERDICT: CLEAR
