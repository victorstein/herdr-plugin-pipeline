# Spec review 0 — issue #10 (`--files` validation and echo)

Reviewed `docs/superpowers/specs/2026-09-17-issue-10-design.md` at `a4fffdf` against `gh issue view 10`,
`docs/superpowers/research/2026-09-17-issue-10-research.md`, the code in this worktree, the live ledger,
and the sibling issues currently open.

**What holds.** I re-derived the whole measured surface and the spec is accurate on every mechanical
point I checked. `listFlag` at `src/cli.ts:340-343` and `flag` at `335-338` are quoted correctly; the two
`listFlag` call sites are `src/cli.ts:385-386`; `cmdTask`'s validation block is `62-74` and `102-107`; the
two success returns are `117` and `126`; the message house shape at `67`, `73`, `104`, `107` is as
described; `fail()` does reach stdout and exit 1 at `441-442`; `src/cli.ts:215` is the `released …; files
reservation cleared` precedent; `task.files` is `string[]` at `src/lib/types.ts:66`; `gating.ts:15-18`,
`19-21`, `49-53`, `60-70` and `status.ts:46-62` are all where the spec says. I re-ran the parser
measurements against a copy of `flag`/`listFlag` and got exactly the research's results
(`repeated → ["a/"]`, `valueless → ["--surface"]` with `--surface` still resolving to `core`,
`trailing → []`, `a/,,b/ → ["a/","b/"]`, `depends-on repeated → ["t1"]`). The berean-os ledger still on
disk confirms 5 of 6 tasks with a single whitespace-bearing entry and `t6` clean. Baseline reproduces:
`bun run typecheck` silent, `bun test` → 414 pass / 0 fail. The C2 insertion is safe against the test
suite more broadly than the spec claims — every `.text` assertion in `test/cli-commands.test.ts`
(lines 54, 114, 286, 301, 316, 317, 330, 331) is `toContain`/`not.toContain`, so no positional assertion
exists anywhere. A1, A2, A6, A7 and the three Rejected alternatives are argued honestly and I would not
overturn any of them.

The findings below are about the seams, not the parsing.

---

## BLOCKER 1 — C4 claims a file outside #10's own `--files` declaration, contested with the concurrently in-flight #13

**Claim.** C4's edit table (spec:131-139) lists five edits across "four files", the fifth being
`test/integration/smoke.md` line 100. The Non-goals "Sibling boundary" (spec:70-71) states the boundary as
"`src/supervisor/tick.ts`, `src/supervisor/deliver.ts` and `prompts/digest.md` belong to #13 and are not
touched."

**Problem.** `test/integration/smoke.md` is declared by neither task, and #13 is in flight right now with
a documented reason to edit the same file. The spec's boundary statement enumerates exactly #13's declared
holdings — so the author read the declarations — and then claims a file that is in neither set. The file
gate cannot serialize this, because the gate only knows what was declared at registration; and the design
cannot repair it itself, because, as the spec's own Rejected alternatives note (spec:307-308), "there is no
command that edits `task.files`, only `cmdRelease` which clears it wholesale." Whether #10 takes
`smoke.md`, #13 takes it, or a merge order is fixed is an ownership ruling, not an inline edit.

**Evidence.** The live run, read from
`~/.local/state/herdr/plugins/stein.pipeline/runs/pipeline/herdr-plugin-pipeline-20260917-validate-the-silent-gates-rjms.json`:

    RUN herdr-plugin-pipeline-20260917-validate-the-silent-gates-rjms execute
        t1 #10 spec-review ["src/cli.ts","prompts/intake.md","prompts/dispatch.md","README.md"]
        t2 #13 spec-review ["src/supervisor/tick.ts","src/supervisor/deliver.ts","prompts/digest.md"]

Both tasks are in `spec-review` concurrently. `test/integration/smoke.md` appears in neither list.
`gh issue view 37` names this exact pair, in this exact batch, as an open unresolved collision:

> **Batch 2 (2026-09-17).** `test/integration/smoke.md` is claimed by neither #10 nor #13, and both have
> reason to edit it — #10 to assert the new `files:` echo at §2, #13 for the digest section the runbook
> also documents.

`smoke.md` does carry orchestrator-digest prose (`test/integration/smoke.md:164-165`), so #13's claim is
real, not hypothetical. #37 also records the batch-1 precedent where this went wrong
(`src/supervisor/deliver.ts` added by #15's spec into a file declared by #9), and this repo's precedent for
resolving it is an explicit merge-order section issued "Per the orchestrator's ruling" — see PR #28's body
(`git show 93f79b2`, "## Merge order").

**Concrete fix.** Escalate to the orchestrator before the plan phase and record the ruling in the spec.
One of:
(a) drop `test/integration/smoke.md` from C4 entirely and state in Non-goals that the stale assertion at
`smoke.md:100` is left for whoever owns the runbook, naming #37; or
(b) get the runbook assigned to #10, and record the merge order against #13 in the spec and the PR body
the way PR #28 does.
Note that (a) interacts with MAJOR 3: `smoke.md` is currently the spec's only proposed end-to-end proof.

---

## MAJOR 1 — A9 and the `hpipe status` non-goal hand the durable-state gap to #23, which owns no part of it; #17 and #37 do

**Claim.** Non-goals (spec:56-59): "Making 'the file set is suspicious' a reportable state belongs with
#23, which already owns the 'absent/wrong artifact is a distinct reportable state' problem." A9
(spec:245-249): "the durable-state signal stays with #23 … owned by #23 for exactly this kind of 'make it
a distinct reportable state' work."

**Problem.** #23 contains no mention of files at all. Its scope is artifacts, and it says so in one
sentence. Meanwhile two other open issues explicitly own the two halves of what A9 is handing off — and
the spec cites neither. A9's substance (this is not #10's job) may well survive, but as written it hands a
real gap to an issue that will not close it, which is precisely the "fell through the gap" pattern #23's
own body was filed to document.

**Evidence.** `gh issue view 23 --json body | grep -in files` returns nothing. Its own scoping sentence:
"This issue owns the remainder: **an idle worker in an artifact phase with no identifiable artifact must
produce a signal.**" By contrast `gh issue view 17` names the read-back directly:

> Add `hpipe show --task <id>` printing the recorded task: branch, issue, surface, **files**, depends_on,
> phase + age, artifact paths, PR, CI.

and its evidence is this very bug: "Confirming the `--files` bug meant reading plugin source and then
hunting down the run's state file by hand." The proactive status warning is #37's third direction:
"when two in-flight tasks' working trees both modify a path, surface it in `hpipe status` as a warning …
That turns a silent race into a visible one, which is the same move #23 makes for missing artifacts" —
i.e. #37 itself distinguishes its own subject from #23's.

**Concrete fix.** Rewrite A9 and the `hpipe status` non-goal to hand off to the issues that actually own
each half: the on-demand read-back of `task.files` to **#17** (`hpipe show --task <id>`), and the
proactive in-flight overlap warning in `hpipe status` to **#37**. Drop the #23 citation, or keep it only
as the stated precedent for the *shape* of such a signal, which is how #37 uses it.

---

## MAJOR 2 — the `test/prompts.test.ts` survey that clears C4 is a wrong reading of that file, and it misses the one guard C4 can actually trip

**Claim.** Spec:142-144: "`test/prompts.test.ts:17-34` guards only the declared prompt set, orphan files
and the review trailer, so none of this breaks a test — verified by reading that file."

**Problem.** That file is 148 lines and 18 tests, not 34 lines and 3. Among the tests the spec did not see
is one that fails **any** prompt file containing the literal string `hpipe`, and C4's load-bearing edit
(spec:141: "`prompts/intake.md:27-29` is the load-bearing one") is new prose into a prompt describing what
`hpipe task` prints. An implementer writing "`hpipe task` now also prints `files:`" instead of
"`{{hpipe}} task`" turns the suite red, and the spec has explicitly told them this file cannot affect them.
The conclusion happens to be survivable, but the verification behind it is not, and the one real
constraint on the one new-prose edit is absent.

**Evidence.** `test/prompts.test.ts:68-76`:

```ts
test('no prompt hardcodes the hpipe binary — it must be rendered', async () => {
  for (const name of ALL) {
    const text = await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
    const bare = text.replace(/\{\{hpipe\}\}/g, '')
    expect(bare, `${name}.md hardcodes hpipe; use {{hpipe}}`).not.toContain('hpipe')
  }
})
```

`ALL` (lines 10-14) includes `intake` and `dispatch`. The same file also guards `dispatch.md` for
`worktree create --cwd {{repo_root}}` (60-66) and asserts three exact strings in `README.md` (88-100) —
the other two files C4 edits. None of those three assertions is hit by C4 as scoped (README line 80 is not
among them), but the spec's stated basis for saying so is a read of the wrong 18 lines.

**Concrete fix.** Replace the sentence with the accurate scope of `test/prompts.test.ts`, and add one line
to C4 stating the constraint: **new prose in `prompts/intake.md` must write `{{hpipe}}`, never a literal
`hpipe`** (`test/prompts.test.ts:68-76`), and must not disturb `README.md`'s pinned strings
(`test/prompts.test.ts:88-100`) or `dispatch.md`'s `--cwd {{repo_root}}` assertion (`:60-66`).

---

## MAJOR 3 — "the unit tests do cover the behaviour" is false for C3, whose only reachable proof is left optional

**Claim.** Testing strategy (spec:282-288): "Everything here is pure argv-and-string work inside one
exported function with no herdr I/O, no pane delivery, no startup and no gating change, so the unit tests
do cover the behaviour." And then: "The plan phase decides whether that runbook edit is in scope."

**Problem.** C3 does not live inside one exported function. `listFlag` is fed only by `dispatch`, which is
module-private and has no test, so no unit test can prove that `--files` and `--depends-on` actually reach
`cmdTask` through the rewritten `listFlag`. Exporting `listFlag` (A5) proves the helper, not the wiring —
and the wiring layer is exactly where #10's defect lived: nothing was wrong with any pure function on the
berean-os run, the argv path handed `filesClearFor` garbage and `filesClearFor` was correct over it
(spec:26-30). `.claude/agents/plugin-dev.md:55-59` names this hazard by hand ("Unit tests use
dependency-injected fakes and have passed clean over real defects twice"), and this repo's project memory
records the same lesson. Having asserted unit coverage is sufficient, the spec then leaves the only
end-to-end check it proposes to the plan phase's discretion — and per BLOCKER 1 that check may not even
be #10's to write.

**Evidence.** `grep -n "^export" src/cli.ts` lists 13 `cmd*` functions and 2 interfaces; `dispatch`
(`src/cli.ts:355`), `flag` (`335`) and `listFlag` (`340`) are all module-private. The sole `--files`
argv site is `src/cli.ts:386`, inside `dispatch`'s `case 'task'`, reachable only by executing the CLI.
`grep -rn "listFlag" test/` returns nothing today.

**Concrete fix.** State a mandatory verification that exercises the argv path rather than the helper, and
say where it lives. The cheapest form needs no runbook and no live ledger: invoke the CLI in a scratch
`HERDR_PLUGIN_STATE_DIR` with a stub repo and assert on real stdout for four invocations — a comma value,
a repeated flag, a space-separated value (rejected), and no flag (`files: none`). Either commit to that in
the spec, or — if `smoke.md` survives BLOCKER 1 — make the runbook edit in scope rather than deferring it,
and delete the "the unit tests do cover the behaviour" sentence, which is the claim the hazard note in
`plugin-dev.md` exists to refuse.

---

## MINOR 1 — the churn premise under the `hpipe status` non-goal is wrong on both counts

Spec:58-59 says "`src/lib/status.ts` was rewritten by #15 two commits ago." `git log --oneline -- src/lib/status.ts` gives
`93f79b2 fix: re-probe stalled phases and escalate them to a human (#28)` as the last touch, which is
`HEAD~5` (a4fffdf, 6c75122, 343dde4, 0aa1dbf, ff99f40, 93f79b2), and `git show --stat 93f79b2 --
src/lib/status.ts` is `1 file changed, 19 insertions(+)` — an addition, not a rewrite. The "freshly
churned, stay off it" implication does not hold. Fix: drop the clause, or state it accurately; the
non-goal stands on ownership (MAJOR 1) without it.

## MINOR 2 — "fourteen `cmd*` functions" is thirteen

A5 (spec:223-224): "`src/cli.ts` already exports fourteen `cmd*` functions."
`grep -c "^export async function cmd" src/cli.ts` → `13`. Fix: thirteen.

## MINOR 3 — C4 and the testing strategy contradict each other on whether the runbook edit is in scope

C4 (spec:139) lists the `test/integration/smoke.md:100` correction as one of the five committed edits;
the testing strategy (spec:288) says "The plan phase decides whether that runbook edit is in scope." A
reader can just about separate the two edits (a mandatory correction of a now-stale assertion vs. a new
assertion plus a new rejection step), but the spec never says so, and BLOCKER 1 makes the ambiguity
load-bearing. Fix: name the two runbook edits separately and say which is committed.

## MINOR 4 — C3 changes `--depends-on` parsing on the very lines C4 edits, and leaves it undocumented

A4 (spec:211-217) accepts that C3 makes a repeated `--depends-on` accumulate, on the grounds that the
silent drop is the same class of failure. But Goal 4 and C4 name the comma separator for `--files` only,
even though all three doc sites carry both flags **on the same line** —
`prompts/intake.md:24` and `prompts/dispatch.md:31` both read `[--depends-on <task_ids>] [--files
<path-prefixes>]`, and `README.md:80` reads `[--depends-on <ids>] [--files <prefixes>]`. So the edit
leaves `--depends-on` as an unseparated plural next to a newly separated `--files`, and the new
repeat-the-flag capability is documented nowhere. Harm is low — a space-separated `--depends-on "t1 t2"`
is already caught by `src/cli.ts:104` ("names no such task") — but the asymmetry is gratuitous given the
line is being retyped anyway. Fix: write `[--depends-on <id,id>]` in the same three edits.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 3
