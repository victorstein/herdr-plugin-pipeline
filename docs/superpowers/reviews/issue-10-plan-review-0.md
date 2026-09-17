# Plan review 0 — issue #10 (`--files` validation and echo)

Reviewed `docs/superpowers/plans/2026-09-17-issue-10-plan.md` at `ecd348d` against
`docs/superpowers/specs/2026-09-17-issue-10-design.md`,
`docs/superpowers/reviews/issue-10-spec-review-1.md`, `.claude/agents/plugin-dev.md`, and the code in
this worktree. Every mechanical claim below was re-measured rather than taken from the plan or from
the earlier reviews.

## What I verified, and what held

**The baseline is real.** `bun test` → `414 pass, 0 fail, 903 expect() calls, 33 files`; `bun run
typecheck` → clean, exit 0. The plan's ledger row for the baseline (`plan:24-25`, `plan:793`) is
exact, and 414 + 4 + 1 + 1 + 1 + 1 + 5 = 427 arithmetic across `plan:791-800` is correct. The new
file makes 34, as the PR body says (`plan:757`).

**The mechanical surface is where the plan says it is.** `listFlag` is `src/cli.ts:340-343`
(plan:87); the `--surface` check closes at `src/cli.ts:74` and `const date` is `:76`, so Step 2b's
insertion point exists exactly as described (plan:171-180); the two success returns are
`src/cli.ts:117` and `:126` (plan:334-338, 405); `dispatch` is `src/cli.ts:353` (plan:429);
`prompts/intake.md:24` and `:27-29`, `prompts/dispatch.md:31` and `:23-26`, and `README.md:80` all
carry verbatim the text the plan quotes (plan:575-634); `test/integration/smoke.md:87-89`, the fence
at `:91-94`, the `**Observe:**` block at `:100-103` and the deferred digest prose at `:164-165` are
all as cited (plan:658-699).

**I ran the Step 6 fixture before reviewing it.** Spawning `bun run src/cli.ts` with
`HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_ROOT`, `HERDR_SESSION` and `HERDR_SOCKET_PATH` pinned exactly
as `plan:472-478` writes them, against a `git init`-ed temp repo carrying
`.claude/agents/core-dev.md`: `start` exits 0, `runs/argv-fixture` really is created under the
scratch state dir (so `plan:504`'s assertion holds and the ledger layout is
`<stateDir>/runs/<session>/` per `src/lib/ledger.ts:7`), `bun run` forwards `--issue`/`--branch`
through to `process.argv.slice(2)` intact, and the valueless case
`task --branch … --issue 1 --files --surface core` exits **0** today with `--surface` resolved to
`core` and no `no agent definition` — which is precisely the silence Step 6a test 4 is written to
break, so that test is a genuine red-to-green proof and not a tautology.

**Two typed details that would have broken a step, and do not.** `SyncSubprocess.exitCode` is
`number`, not `number | null` (`node_modules/bun-types/bun.d.ts:8040`), so
`{ code: number; out: string }` at `plan:482` typechecks under `strict` +
`noUncheckedIndexedAccess`. And `{{notes}}` really is rendered, at `prompts/worker-brief.md:15`, so
Step 5a's `expect(t1.text).toContain('core work')` (`plan:392`) will pass.

**Nothing machine-parses the two returns C2 edits.** `src/lib/machine.ts:91` and
`src/supervisor/tasks.ts:359` are a history write and a `{{task_id}}` render variable, not stdout
parsers; `src/hooks/` and `src/actions/` never mention `task_id`; the only `cmdTask` calls in
`test/cli-commands.test.ts` (`:142`, `:163`) assert on the saved `Task`, never on `.text`. Step 4c's
note about `test/cli.test.ts:48` (`plan:360-361`) is right — that test's three assertions are
`toContain` / `not.toContain` and survive an inserted line.

**All six review-1 fixes are really folded in, not merely tabulated.** I checked each against
`issue-10-spec-review-1.md` rather than against the plan's own table at `plan:776-783`:

| review-1 finding | required fix | present? |
|---|---|---|
| MAJOR 1 | fifth C5a row for the flag-shaped rule, asserting `--surface` stayed well-formed; reword Goal 5 | Yes — `plan:525-535` and `plan:785-787` |
| MAJOR 2 | lift the malformed registration out of the orchestrator's fence, own labelled step, `**Failure looks like:**` clause naming `hpipe abort`, and state §2 must yield `t1`/`t2` | Yes — `plan:661-677` and `plan:698` |
| MINOR 1 | stop citing the unreproducible `task_id:` grep | Yes — not repeated; `plan:780` replaces it with the real constraint |
| MINOR 2 | `f8b9a67~6`, and `dispatch` at `:353` | Yes — `plan:429`; no offset anywhere |
| MINOR 3 | pin `HERDR_PLUGIN_ROOT`; `cwd` on all invocations; `cleanupFixtures` | Yes — `plan:475`, the single `hpipe()` helper at `plan:482-487`, `plan:454` |
| MINOR 4 | extend `prompts/dispatch.md`'s handover paragraph, not just its usage line | Yes — `plan:610-623` |

Every spec component maps to a step (C1→2,3; C2→4,5; C3→1; C4→7,8; C5a→6; C5b→8), every spec goal is
reachable, no non-goal is violated (`gating.ts`, `status.ts`, `phases.ts`, `schema_version` and #13's
three files are untouched, and `smoke.md:164-165` is explicitly fenced off at `plan:652-653`). Names
and signatures are stable across steps: `listFlag(argv: string[], name: string): string[]`,
`filesLine`, `Fixture`/`fixture()`/`hpipe()`/`started()`/`TASK`. Steps 1-5 each open with a test that
is genuinely red against the code as it stands and each leaves `bun test` and `bun run typecheck`
green. There are no placeholders: `grep -nEi "TODO|FIXME|as needed|as appropriate|adjust"` over the
plan returns one hit, and it is the deliberate "not a test to adjust" instruction at `plan:551`.

The six findings below are all inline fixes. None reverses a decision, changes scope, or needs a
human call.

---

## MINOR 1 — Step 1a tells the implementer to expect "two failures"; what they will actually see is the whole of `test/cli.test.ts` failing to load

**Claim.** `plan:82-83`: "Expect **two** failures: typecheck/import error on `listFlag` until 1b
lands, and — once exported — `listFlag accumulates…` returning `['a/']`."

**Problem.** Bun does not degrade a missing named export to `undefined`; it refuses the module. The
edit at `plan:51-55` therefore takes every test in `test/cli.test.ts` down, not two of them, and the
"once exported" clause describes a state that only exists after 1b — so at 1a there is exactly one
observable outcome, and it is not the one the plan names. This is the first step in the plan and the
first thing the implementer runs; a red that does not match the predicted red is the moment a plan
loses its reader.

**Evidence.** Reproduced with a two-test file importing one real and one absent export:

    # Unhandled error between tests
    SyntaxError: Export named 'nope' not found in module '…/mod.ts'.
     0 pass
     1 fail
     1 error
    Ran 1 test across 1 file.

Separately, of the four new tests only `listFlag accumulates every occurrence of a repeated flag`
(`plan:64-66`) is red against the current implementation: `plan:60-62` (`'a/,,b/ '` → `['a/','b/']`),
`plan:68-71` (absent flag and valueless flag → `[]`, via `flag`'s `?? null` at `src/cli.ts:337`) and
`plan:73-75` (`['--files','--surface','core']` → `['--surface']`) all pass against
`src/cli.ts:340-343` today.

**Fix.** Reword `plan:82-83`: until 1b lands the file does not load at all (`SyntaxError: Export
named 'listFlag' not found`) and `bun run typecheck` reports TS2305; once 1b lands, exactly one of
the four is red — `listFlag accumulates…`, returning `['a/']` — and the other three are regression
guards that were green from the start.

## MINOR 2 — the hand-run rejection in Step 8a needs an issue number the runbook has not produced yet, and Step 8's "Two edits only" forbids fixing the prose that causes it

**Claim.** `plan:648` ("Two edits only") and `plan:665-667`, which insert
`hpipe task --branch smoke/bad --issue <n1> --surface <surface> --files "src/lib src/lib/config.ts"`
between `smoke.md:89` and the fence at `:91`.

**Problem.** `<n1>` is §2's first *real* GitHub issue number, and `smoke.md:87-89` — which Step 8
declines to touch — reads "Now let the orchestrator do intake for real: it files **two** GitHub
issues, one per task, and registers both." The operator is told to type the malformed command before
the fence, but the number it wants only exists once the orchestrator has already filed *and*
registered. The runbook never says how to hold the orchestrator between those two acts. Worse, the
recovery clause the plan is proudest of — "the ghost would renumber the two real tasks below and
break §3's assertions on `t1`/`t2`" (`plan:673-674`) — is only true if the malformed command really
does run first; run after the orchestrator, the ghost is `t3` and the stated diagnosis is wrong, so
the operator is handed a false explanation at exactly the moment the live run has gone sideways.

**Evidence.** `test/integration/smoke.md:87-89` is unedited by Step 8 (8a inserts at `:90`, 8b
replaces `:100-103`). `cmdTask` never calls `gh`: the only `--issue` constraint is
`Number.isInteger(input.issue) && input.issue > 0` (`src/cli.ts:66-68`), and the number is used only
to build the artifact stem (`src/cli.ts:76-77`) and to render `{{issue}}`. So the malformed command
does not need a real issue at all.

**Fix.** Either (a) write the malformed command with a throwaway number — `--issue 999` — and say in
the step that it never reaches GitHub, which removes the dependency on the orchestrator entirely; or
(b) make Step 8 three edits and split `smoke.md:87-89` into "the orchestrator files the two issues"
and, after the hand-run check, "now let it register both". (a) is the smaller change and is enough.

## MINOR 3 — Step 6a's justification for `afterAll` is factually false, and the repo already has a convention for this

**Claim.** `plan:453-454`:

```ts
// tempDir() registers into a module-level list nothing else drains.
afterAll(cleanupFixtures)
```

**Problem.** Two files already drain it, on every test rather than at file end. The comment will be
committed into `test/cli-argv.test.ts` as a "why" that is untrue on the day it is written — the exact
drift `.claude/agents/plugin-dev.md:32-34` and the repo's comment convention exist to prevent. The
`afterAll` choice also departs from both existing callers for no stated reason, and keeps ten temp
trees (five repos, five state dirs) alive for the file's duration when each test builds its own
fixture and needs none of the others.

**Evidence.** `test/tasks.test.ts:10` → `afterEach(cleanupFixtures)`; `test/deliver.test.ts:12` →
`afterEach(cleanupFixtures)`; the list and its drain are `test/helpers/git-worktree.ts:5` and `:50`
(`for (const dir of created.splice(0))`).

**Fix.** Use `afterEach(cleanupFixtures)`, matching `test/tasks.test.ts:10` and
`test/deliver.test.ts:12`, and drop the comment — the call site needs no justification once it
matches the two files beside it.

## MINOR 4 — the comment Step 2a commits into the test cites `src/cli.ts:111`, which is a comment line, and which the plan itself then moves

**Claim.** `plan:140-141`: "Set so the assertion below can prove the rejection returned before line
111, which reopens intake."

**Problem.** `run.intake_closed = false` is `src/cli.ts:112`; `:111` is the second line of the
`why`-comment above it. So the citation is off by one at the moment it is written — and Step 2b then
inserts a fourteen-line block at `:75`, which moves the real statement to roughly `:126` before the
step is even committed. A line number is the one thing a comment cannot keep true here, and this one
is not load-bearing: the two assertions at `plan:160-161` say the same thing precisely.

**Evidence.** `awk 'NR>=109 && NR<=113' src/cli.ts`:

    109	  run.tasks.push(task)
    110	  // execute completes only once intake is closed and every task is terminal, so a
    111	  // task registered mid-run must reopen the gate or the run could complete underneath it.
    112	  run.intake_closed = false

**Fix.** Drop the line number: "Set so the assertion below can prove the rejection returned before
`run.intake_closed = false`. A fresh run already has it false."

## MINOR 5 — the Ground rules send the implementer to Step 7 for a warning that is in Step 6

**Claim.** `plan:17-18`: "**Never point `hpipe` at this checkout.** Step 7 runs `src/cli.ts` as a
subprocess, and its environment is pinned for exactly this reason — read Step 7's warning before you
write it."

**Problem.** Step 7 (`plan:563-642`) edits `prompts/intake.md`, `prompts/dispatch.md` and
`README.md` and spawns nothing; its only blockquote is the `test/prompts.test.ts:68-76` literal-
`hpipe` guard. The subprocess and the pinned environment are Step 6, whose warning is the blockquote
at `plan:432-438`. An implementer who follows this rule literally reads the wrong warning, and the
one rule in the plan that guards against writing fixtures into the live ledger is the one that
misfiles itself.

**Evidence.** `plan:426` ("**Files:** `test/cli-argv.test.ts` (new)"), `plan:432-438` (the
"Read this before you write the file" blockquote), against `plan:565` ("**Files:**
`prompts/intake.md`, `prompts/dispatch.md`, `README.md`").

**Fix.** Change both occurrences of "Step 7" in `plan:17-18` to "Step 6".

## MINOR 6 — two line citations are stale by the time the step that uses them runs

**Claim.** `plan:682` ("Replace lines 100-103") and `plan:429` ("`dispatch` (`src/cli.ts:353`)").

**Problem.** Step 8a inserts about seventeen lines at `smoke.md:90`, so by the time 8b runs the
`**Observe:**` block is near `:117`, not `:100`. Likewise, Steps 1-5 add roughly thirty lines above
`dispatch`, which by Step 6 sits near `:382`. Both are recoverable — each step quotes the text
verbatim — but the plan's own Baseline section tells the implementer that a moved line number means
"something landed underneath this plan" and to stop (`plan:27-28`), so a stale citation reads as a
stop signal.

**Evidence.** `sed -n '100,103p' test/integration/smoke.md` matches `plan:685-688` today;
`grep -n "async function dispatch" src/cli.ts` → `353` today. Both change as a direct consequence of
earlier steps in this same plan.

**Fix.** Mark both as baseline-relative: "lines 100-103 of the file as it stands at the baseline —
after 8a they sit about seventeen lines lower; match on the text" and "`src/cli.ts:353` at the
baseline". The Baseline caution at `plan:27-28` should then say it applies to line numbers that move
for reasons *other* than this plan's own earlier steps.

---

Counts: 0 BLOCKERs, 0 MAJORs, 6 MINORs. Every finding is a wording, citation or convention fix inside
a step whose substance is correct; none touches a decision, the scope the ownership ruling fixed, or
anything only the human can call. The plan's claim at `plan:8-9` — that an implementer needs no
context beyond the spec and the plan — holds, and its claim to have absorbed all six review-1 fixes
is true on re-derivation.

VERDICT: CLEAR
