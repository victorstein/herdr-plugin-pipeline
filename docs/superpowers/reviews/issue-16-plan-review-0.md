# Plan review — issue #16, pass 0

Target: `docs/superpowers/plans/2026-09-19-issue-16-plan.md`
Against: `docs/superpowers/specs/2026-09-19-issue-16-design.md` (VERDICT: CLEAR,
`docs/superpowers/reviews/issue-16-spec-review-0.md`)

Pass 0 confirmed: `ls docs/superpowers/reviews/ | grep issue-16-plan` → empty.

## What I did, and what it establishes

I did not read the plan and reason about it. I **executed it**, literally, step by step, on a copy of
this worktree in the scratchpad (`rsync -a --exclude .git`, `node_modules` symlinked in), pasting
every quoted block exactly as written and applying every prose edit at the anchor the plan names.
The real worktree was not touched (`git status --porcelain` → clean, `bun test` → 503 pass / 0 fail
across 34 files, `bun run typecheck` → exit 0, before and after).

Result of executing steps 1–9 verbatim:

    $ bun run typecheck   # exit 0
    $ bun test
     525 pass
     0 fail
     1300 expect() calls
    Ran 525 tests across 35 files.

503 + 11 (`test/bootstrap.test.ts`) + 2 (`test/tasks.test.ts`) + 4 (`test/cli-commands.test.ts`) +
5 (`test/prompts.test.ts`) = 525. Every quoted `.ts` block compiles under this repo's `strict` +
`noUncheckedIndexedAccess` tsconfig. Every step's red was genuinely red before its green (I ran each
one). Every `file:line` citation I checked resolves: `src/cli.ts:252-255`/`:256`/`:260`/`:268`/`:269`,
`src/supervisor/tasks.ts:149-155`, `src/lib/repo.ts:17-25`, `src/lib/worker-prompt.ts:27-31`,
`prompts/dispatch.md:26-28`, `prompts/worker-brief.md:14`, `test/helpers/git-worktree.ts:12-16`,
`test/prompts.test.ts:60-66`/`:68-76`/`:88-100`, `test/cli.test.ts:206-226`/`:228-246`,
`.claude/skills/conventional-pr-titles/SKILL.md`, `.github/workflows/pr-title-lint.yml`. Every spec
component **C1**–**C6** maps to a step; the `repoBootstrap` / `bootstrapLine` / `briefNote` /
`BOOTSTRAP_REL` signatures in step 1–3 are byte-identical to the spec's C1 block at
`specs/2026-09-19-issue-16-design.md:204-213` and are used consistently at every later call site
(steps 4, 5, 7). Spec testing items 1–8, 10–12, 14, 15, 17–21 are all pinned by a named test.

So the central question — *could an implementer with no other context execute this plan literally and
arrive at the spec?* — is **yes, demonstrably**. The findings below are real but none of them stops
that from being true.

---

## MAJOR 1 — no step verifies anything outside the one test file it targets, so "every step leaves the tree green" is asserted, never established

**Claim.** `plan:38` — "Each step: write the test, run it and see it fail for the stated reason,
write the minimum code, run it again, commit. **Every step leaves the tree green.**"

**Problem.** No step in 1–9 ever runs `bun test` (the whole suite) or `bun run typecheck`. Every
green gate is a single targeted file: `plan:135`, `:194`, `:243` (`bun test test/bootstrap.test.ts`),
`:307` (`test/tasks.test.ts`), `:404`, `:453` (`test/cli-commands.test.ts`), `:514`, `:576`, `:641`
(`test/prompts.test.ts`). `bun run typecheck` appears exactly twice in the whole plan — once in the
pre-flight baseline at `:32` and once at `:663`, inside step 10, **after nine commits**. This is
against the repo's own non-negotiable (`.claude/agents/plugin-dev.md`: "`bun test` and
`bun run typecheck` both green before you push").

This is not hypothetical bookkeeping. Four of the nine steps mutate code or prompt text that other
test files consume, and the plan's verification command for each one cannot see them:

| Step | Mutates | Other files that read it, never run |
| --- | --- | --- |
| 4 (`plan:289-307`) | `src/supervisor/tasks.ts` | `test/deliver.test.ts`, `test/tick.test.ts` |
| 5/6 (`plan:383-453`) | `src/cli.ts` `cmdTask` output shape | `test/cli.test.ts:206-246`, `test/cli-argv.test.ts:52-98` — the two files the spec itself names as the modelled precedents (`design.md:433-440`) and whose `toContain`-only assertions are the spec's stated reason a third header line is safe (`design.md:51-52`) |
| 7 (`plan:492-514`) | `src/lib/worker-prompt.ts`, `prompts/worker-brief.md` | every test that renders a brief — `test/tasks.test.ts`, `test/cli.test.ts`, `test/cli-commands.test.ts` |
| 9 (`plan:607-620`) | adds `.claude/pipeline-bootstrap` at **this** repo's root, changing `repoBootstrap(ROOT)` from `none` to `ready` for anything keyed off the repo root | the whole suite |

**Evidence.** I ran the full suite after each step and it does hold — 525/0, typecheck clean. So the
risk is procedural, not latent: the plan happens to be safe, but its own instructions do not prove
it, and an implementer who deviates by a word (say, a different `bootstrapLine` string) would carry a
broken `test/cli-argv.test.ts` through nine commits before `plan:662-663` catches it. Step 10 then
begins with a rebase, which is the worst possible place to first discover a red suite.

**Fix.** Change the closing gate of every step 1–9 from the targeted run to:

    $ bun test <the targeted file>   # the step's own count
    $ bun test && bun run typecheck  # whole tree, before the commit

and say so once in *Before you start* (`plan:38`) instead of only asserting greenness.

---

## MAJOR 2 — the README anchor at `plan:622-623` files the rest of `## Install` under the new bootstrap subsection

**Claim.** `plan:622-623` — "In `README.md`, insert after the paragraph ending "`@types/bun` and
`typescript` are devDependencies for `bun run typecheck` only." (`:30-31`)", followed by a
`### Bootstrapping worker worktrees` block (`plan:625-639`).

**Problem.** `README.md:30-31` is the *third* paragraph of `## Install`, not its last.
`## Install` runs from `README.md:20` to `README.md:69`; the next heading of any level is `## Use` at
`:70`. Inserting an `###` at `:32` puts everything from `:33` to `:69` — "**There is nothing else to
install.**", the herdr actions table, the `Install the hpipe shorthand` paragraph, the
"link `bin/hpipe`, never `src/cli.ts`" warning, the restart-the-session note and the
"run `hpipe` from inside a pane" note — **inside** a subsection titled "Bootstrapping worker
worktrees", which has nothing to do with any of it. It also lands "There is nothing else to install"
immediately under a heading that tells the reader to write an install script, which reads as a
contradiction.

**Evidence.** Applied verbatim in the scratch copy:

    $ grep -n "^#\{1,4\} " README.md
    20:## Install
    33:### Bootstrapping worker worktrees
    86:## Use

Fifty-three lines mis-nested. Before the change the same grep gives `20:## Install` → `70:## Use`.

The spec asks only that "**`README.md`** gains a subsection under **Install**"
(`design.md:334-336`) — it does not pick the anchor, so this is the plan's choice and the plan is
free to move it.

**Fix.** Replace the anchor in `plan:622-623` with: *insert immediately before the `## Use` heading
(`README.md:69-70`), after the paragraph ending "it silently falls back to the `default` session's
ledger."* — keeping the subsection last inside `## Install`, where it nests nothing.

---

## MINOR 1 — three of the nine "see it fail for the stated reason" lines state the wrong reason

**Claim.** `plan:175-176` "fails: `bootstrapLine` is not a function"; `plan:219-220` "fails:
`briefNote` is not a function"; `plan:604-605` "fails: expected true, got false".

**Problem.** Steps 2 and 3 add the symbol to a **static** `import` (`plan:146`, and `plan:202`'s
"merge the import again"), so the failure is a module-link error, not a call-site `TypeError`. It
takes the entire file down, including the tests the previous step just made pass — the implementer
sees `0 pass / 1 fail`, not `9 pass / 2 fail`, and `bun run typecheck` is also red at that moment
(TS2305). Step 9 appends *two* tests (`plan:587-598`); the README one is declared first and fails
first, with `expect(received).toContain(expected)`, not `expected true, got false`.

**Evidence.** Reproduced in isolation:

    $ bun test test/b.test.ts
    # Unhandled error between tests
    SyntaxError: Export named 'bootstrapLine' not found in module '.../src/lib/bootstrap.ts'.
     0 pass
     1 fail
     1 error

and for step 9, the first failure printed is `(fail) the README documents the per-repo bootstrap
contract` with a `toContain` diff over the whole README.

**Fix.** `plan:176` → `# fails: SyntaxError: Export named 'bootstrapLine' not found in module
'…/src/lib/bootstrap.ts' — the whole file fails to link, so the 5 passing tests go red too`;
`plan:220` the same for `briefNote`; `plan:605` → `# fails: 2 tests — 'the README documents the
per-repo bootstrap contract' (toContain) and 'this repo declares its own bootstrap' (expected true,
got false)`.

---

## MINOR 2 — the quoted test blocks ship a dead import, a dead parameter, and an import note that is factually wrong

**Claim.** `plan:321-322` `import { chmodSync } from 'node:fs'` / `import { bootstrapLine,
repoBootstrap } from '../src/lib/bootstrap'`; `plan:325` `function declareBootstrap(mode = 0o755)`;
`plan:283-284` "`tempDir` and `join` are already imported at the top of that file …; add only the
`node:fs` names shown."

**Problem.** Three separate bits of debris an implementer pasting literally will commit:

1. `bootstrapLine` and `repoBootstrap` are imported into `test/cli-commands.test.ts` at `plan:322`
   and **never used** by any of the four tests in steps 5 and 6. The tests assert literal strings
   (`plan:343`, `:359-361`, `:376`, `:437`). `noUnusedLocals` is not set in `tsconfig.json`, so
   `bun run typecheck` stays green and nothing catches it.
2. `declareBootstrap`'s `mode` parameter (`plan:325`) is never passed by any caller — all four call
   sites are the bare `declareBootstrap()` (`plan:333`, `:347`, `:422`).
3. `plan:283-284` is wrong about `test/tasks.test.ts`: `mkdirSync` and `writeFileSync` are **already**
   imported there at `test/tasks.test.ts:2`. Only `chmodSync` is new. The plan's aliased second
   `node:fs` import (`plan:254`) therefore re-imports two names under `mkdir`/`write` for no reason.
   It compiles and runs — I verified it — but it is gratuitous, and the note that justifies it is
   false.

**Evidence.** `sed -n '2p' test/tasks.test.ts` →
`import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'`. Full suite green with all three
defects present, so no gate fires on any of them.

**Fix.** Delete `plan:322`. Change `plan:325` to `function declareBootstrap(): void` (or give it a
caller — see MINOR 3). Change `plan:254` to `import { chmodSync } from 'node:fs'` and rewrite
`plan:283-284` as "`tempDir`, `join`, `mkdirSync` and `writeFileSync` are already imported at
`test/tasks.test.ts:1-3`; add only `chmodSync`."

---

## MINOR 3 — `not-executable` is pinned only at the unit boundary; its worker-facing half is never executed

**Claim.** **C5** is the spec's "most droppable" component (`design.md:299-306`) and the plan keeps
it whole: detection (`plan:128`), the header line (`plan:187-189`) and a `briefNote` caveat
(`plan:231-233`).

**Problem.** `briefNote`'s `not-executable` branch — the `caveat` string at `plan:231-233` — is
reached by **no test in the plan**. Step 3's two tests cover `none` (`plan:205-207`) and `ready`
(`plan:209-216`) only, matching spec item 9 (`design.md:428-429`), which also omits it. Combined
with MINOR 2's unused `mode` parameter, the whole `not-executable` path above `bootstrapLine` ships
unexercised: no `cmdTask` test, no supervisor test, no brief test. If C5 is worth its cost, its
recovery text should be pinned; if it is not, the plan is the place that discovers that.

**Evidence.** `grep -c "not-executable" ` over the plan's test blocks: three occurrences, all in
step 1's detection tests (`plan:78`, `:159`, `:167`) plus step 2's `chmod +x` line assertion. None
in step 3, 5, 6 or 7.

**Fix.** Add one assertion to step 3's second test and give `declareBootstrap`'s `mode` a caller:

    test('a non-executable declaration tells the worker to chmod it', () => {
      expect(briefNote({ kind: 'not-executable' })).toContain(`chmod +x ${BOOTSTRAP_REL}`)
    })

and in step 5, one `declareBootstrap(0o644)` case asserting
`result.text).toContain('NOT EXECUTABLE')`.

---

## MINOR 4 — spec testing item 13 asks for the header-shape contract on the undeclared path; the plan drops it to a `toContain`

**Claim.** `design.md:457` — "13. A repo with no declaration yields `bootstrap: none` **and still
satisfies test 12**", where test 12 is the blank-line contract (`design.md:453-456`).

**Problem.** The plan's implementation of item 13 (`plan:367-377`) asserts only
`expect(result.text).toContain('bootstrap: none')`. The "and still satisfies test 12" half — that the
header block is exactly three lines and the brief's `# <branch> — issue #<n>` heading is the first
thing after the blank line — is asserted for the *declared* case (`plan:356-364`) and nowhere for
the undeclared one. The undeclared case is the one 100% of repos hit today, and it is the case
`bootstrapLine`'s empty-ish output could most plausibly collapse.

**Fix.** Replace `plan:376` with the same destructure used at `plan:356-364`:

    const [head, ...rest] = result.text.split('\n\n')
    expect(head!.split('\n')).toEqual(['task_id: t1', 'files: none', 'bootstrap: none'])
    expect(rest.join('\n\n')).toStartWith('# feat/quiet — issue #2')

---

## MINOR 5 — `briefNote`'s line wrap forces an assertion weak enough to pass on the wrong sentence

**Claim.** `plan:234` wraps after "which should have been", and `plan:213` therefore asserts
`expect(note).toContain('should have been')`, with `plan:240-241` explaining why the assertion stops
there.

**Problem.** The plan noticed a real trap — spec item 9 (`design.md:428-429`) asks for
`should have been run`, which **neither** the spec's own quoted wrap (`design.md:289-291`, breaking
after "should have") nor the plan's satisfies as a contiguous string — and resolved it by weakening
the assertion instead of moving the break. `toContain('should have been')` passes on "should have
been deleted", "should have been skipped", or any future rewrite that inverts the meaning. The paired
`not.toContain('run for you')` (`plan:214`) pins the *old* wording's absence, not the new wording's
presence, so between them nothing holds the conditional-vs-assertive distinction that spec MINOR 1
(`design.md:62`) exists to protect.

**Fix.** Move the wrap one word earlier in `plan:234` so the phrase survives on one line —
`` `> This repo declares a worktree bootstrap at \`./${BOOTSTRAP_REL}\`, which should have been run\n` `` —
then restore the spec's assertion at `plan:213`: `expect(note).toContain('should have been run')`,
and drop the now-unneeded note at `plan:240-241`.

---

## MINOR 6 — step 8's dispatch prose contradicts the spec's `permission denied` error-table row

**Claim.** `plan:569-571` — "Only a script that exists and **exits non-zero** is a reason to stop and
report instead of starting the worker."

**Problem.** `design.md:384` prescribes different behaviour for one specific non-zero exit:
"Declared and executable in `repo_root`'s working tree but `644` in the new worktree → Orchestrator
gets `permission denied`; **treat it as the `not-executable` case and `chmod +x` on the base
branch**". Under the plan's prose an orchestrator that hits `permission denied` stops and escalates
the batch, which is precisely the halt **A13**/MAJOR 1 was reshaped to avoid. The plan matches C6's
enumerated bullets (`design.md:316-323`) exactly, so this is the spec's row going unimplemented
rather than the plan inventing something — but the plan is the last place it can be caught.

**Fix.** Append one clause to `plan:571`: "— except a bare `permission denied`, which means the
checkout's copy is not executable: `chmod +x` it in the new checkout, run it, and carry on."

---

## MINOR 7 — step 10 carries a literal placeholder and a search that does not check what it claims

**Claim.** `plan:669` — `gh pr create --title "…" --body "..."`; `plan:651` —
`gh pr list --state merged --search "26 in:title"     # confirm #26 landed`.

**Problem.** `--body "..."` is a literal placeholder in a plan whose own rule is that steps show how,
not what; the content is enumerated afterwards at `plan:678-687`, so the fix is mechanical. The
`gh pr list` search is a **title substring** match on the string `26`, which matches any PR whose
title contains "26" (a date, a line count, issue #126) and misses #26's PR entirely unless its title
happens to carry the number. The condition being gated is "PR for issue #26 is merged", which is
`gh issue view 26 --json state,closedAt` or `gh pr list --search "linked:issue 26"`.

**Fix.** `plan:651` → `gh issue view 26 --json state --jq .state   # expect CLOSED`, plus
`gh pr list --state merged --limit 20` to eyeball the branch name `fix/26-verdict-overwrite`.
`plan:669` → drop `--body "..."` and write `--body-file <(…)` or point at the bullet list below it
explicitly: `--body "$(cat <<'EOF' … EOF)"` with the four required items as headings.

---

## Things I checked and found sound, so they are not findings

- **Every spec requirement maps to a step.** C1→1-3, C2→4, C3→5-6, C4→7, C5→1/2/3, C6→8-9;
  NG1/NG3/NG6/NG8/NG9 restated at `plan:691-698`; A14's merge-second and conflict-surfacing
  conditions at `plan:17-24` and `plan:649-658`.
- **Signatures are stable across steps.** `repoBootstrap(repoRoot: string): Bootstrap`,
  `bootstrapLine(b: Bootstrap): string`, `briefNote(b: Bootstrap): string`, `BOOTSTRAP_REL` — the
  same shapes at `plan:105-132`, `:185-191`, `:229-237` and at every call site (`plan:292`, `:300`,
  `:386`, `:395`, `:502`, `:508`).
- **`for (const kind of [...] as const) bootstrapLine({ kind })`** (`plan:167-169`) does typecheck
  against the three-member discriminated union — TypeScript distributes the discriminant. Verified,
  not assumed.
- **The blank-line seam survives on both paths.** `plan:298-301` keeps exactly one `\n\n` before the
  brief; `plan:401` likewise. Both are pinned by an executed assertion (`plan:273`, `:356-364`), and
  I confirmed the supervisor message's post-seam text starts with `# feat/x — issue #1`.
- **Step 8's dispatch.md edit does not trip `test/prompts.test.ts:68-76`.** The replacement at
  `plan:549-552` preserves the trailing `` `{{hpipe}} `` that joins to `:29`, and the new subsection
  contains no bare `hpipe`. Verified by running the test after applying it.
- **Step 9 does not break anything by making this repo's own `repoBootstrap(ROOT)` return `ready`.**
  Every fixture keys off a temp dir or `/r`; full suite green afterwards.
- **The routing decision the spec flagged.** `design.md:441-447` said that if the plan phase
  concluded the `cmdTask` output tests belong beside their precedents in `test/cli.test.ts`, that is
  a decision to surface. The plan keeps them in `test/cli-commands.test.ts` (`plan:318`), i.e. it
  agrees with the ruling's grant. Nothing to surface.
- **Ownership.** The plan touches `src/cli.ts` and `test/cli-commands.test.ts` only inside `cmdTask`
  (`plan:389-402`, `:444-451`); `cmdRewind` and `src/supervisor/deliver.ts` — #26's live holdings —
  are untouched.

---

Two MAJORs, seven MINORs, no BLOCKER. Neither MAJOR reverses a decision, changes scope, or needs a
judgment only the human can make: MAJOR 1 is two extra commands per step, MAJOR 2 is moving one
insertion anchor thirty-seven lines down. Both are fixable inline by the implementer, as are all
seven MINORs. The plan's substance — the component-to-step mapping, the signatures, the red-then-green
discipline, the citations — held up under literal execution.

VERDICT: CLEAR
