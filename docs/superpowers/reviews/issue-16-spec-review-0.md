# Spec review 0 (post-rewind) — issue #16 (`docs/superpowers/specs/2026-09-19-issue-16-design.md`)

Reviewed adversarially against `gh issue view 16` (including the **Ownership ruling — `src/cli.ts`,
2026-09-19** appended to the body), `docs/superpowers/research/2026-09-19-issue-16-research.md`,
the preserved pass-0 review (`docs/superpowers/reviews/issue-16-spec-review-pass0-preserved.md`),
the code in this worktree at `cc7492e`, the installed `herdr 0.9.0`, and the live ledger under
`/Volumes/stein/.local/state/herdr/plugins/stein.pipeline/runs/`.

## The pass-0 findings, checked against the current text rather than the disposition table

I re-derived each of the seven, independently of the spec's own table. Six are genuinely applied;
one is applied in substance but leaves a contradiction in the very file it leans on (MAJOR 1).

| Pass-0 finding | Verified state in the current spec |
| --- | --- |
| **BLOCKER 1** (C2 wired only into the supervisor branch) | **Fully applied.** New **C3** instruments `cmdTask`; `src/cli.ts` + `test/cli-commands.test.ts` appear in the Files table marked "by ruling"; the Goal now names both paths; the live-verification list leads with the `hpipe task` output rather than the supervisor message. The ruling's three conditions are all carried in **A14** and **NG8**. The 17-vs-3 count reproduces today: `grep -rho '"why": *"[^"]*"' ~/.local/state/herdr/plugins/stein.pipeline/runs \| sort \| uniq -c` → `17 "why": "dispatched at registration"` / `3 "why": "gate opened"`. |
| **MAJOR 1** (working tree vs the ref the worktree is cut from) | **Applied.** **A13** states it; the error table gains the "absent from the new worktree → skip, no escalation" row; **C6** makes the procedure non-fatal on absence. Residual gap in coverage → MINOR 4 below. |
| **MAJOR 2** (multi-paragraph clause inside the blank-line seam) | **Applied in substance, half-applied in the prompt.** The clause became a single header line, pinned by testing items 7, 12 and 15 — that part is real. But the sentence in `prompts/dispatch.md` that C3 cites as making this free has not been scheduled for amendment → **MAJOR 1** below. |
| **MINOR 1** (`briefNote` asserted the unguaranteed) | **Applied**, verbatim from the reviewer's text; testing item 9 pins `should have been run` and `not "run for you"`. |
| **MINOR 2** (C4's "one `existsSync`" vs **A7**) | **Applied.** **C5**'s cost line now reads "`existsSync` plus the `isFile()` test **A7** requires either way", and the "mirroring `src/cli.ts:188-191` exactly" phrasing is gone. |
| **MINOR 3** (error table stated the defect as the behaviour) | **Applied.** The directory row's behaviour column is `{ kind: 'none' }`; the `mode & 0o111` fact moved to the Why column. |
| **MINOR 4** (declared files vs registered `--files`) | **Applied.** The Files section prints both ledger sets, names #37, and states the holdings rest on the batch split plus the ruling, not the gate. I re-read the ledger and the quoted sets are accurate. |

**What else checked out.** The baseline reproduces exactly as claimed: `bun test` → `503 pass / 0 fail
/ 1265 expect() calls / 34 files`, `bun run typecheck` → exit 0. `herdr worktree create --help` on
the installed `herdr 0.9.0` lists exactly `--workspace --cwd --branch --base --path --label --focus
--no-focus --trust-repository` — **NG1** holds. `deliver.ts:250-255` really passes only
`{run_id, title, pass, verdict_path, repo_root}` to the `dispatch` render, so **A11**'s no-new-token
constraint is correct and `test/prompts.test.ts:68-76` really would fail a literal `hpipe`
(it strips `{{hpipe}}` first). `src/lib/repo.ts:17-25` really yields a directory with no ref in it,
so **A13** is the right shape. `.claude/` is tracked (`git ls-files .claude` → `agents/plugin-dev.md`,
`skills/conventional-pr-titles/SKILL.md`), so shipping `.claude/pipeline-bootstrap` works. Testing
item 16 is correct — `test/tasks.test.ts:26` uses `repoRoot: '/r'` and no existing test in
`test/tasks.test.ts` asserts the dispatch message's shape; I also checked the CLI side and every
existing `files:` assertion is `toContain` (`test/cli.test.ts:224,243`, `test/cli-argv.test.ts:57,67,97`),
so a third header line breaks none of them. The core judgement — repo-declared script, plugin reads
and names it, plugin never executes it — is well evidenced and I would not change it.

---

## MAJOR 1 — C3's "this needs no new convention" is false: the prose it cites enumerates exactly two header lines by name, and C6 never schedules that sentence for amendment

**Claim.** C3: "`prompts/dispatch.md:26-31` already tells the orchestrator that the lines above the
blank line are 'for you and not for the worker', so this needs no new convention and no
`{{token}}`." The disposition table leans on the same reading: the single-header-line reshape "is
what made the fix for BLOCKER 1 cheap". C6 then lists what `prompts/dispatch.md` gains — "what the
`bootstrap:` header line means", where the script is run, and the absent-is-skipped rule — and says
nothing about editing what is already there.

**Problem.** The cited prose is not a generic rule about "the lines above the blank line". It names
a fixed count and enumerates the lines individually, and it attaches a per-line *action* to each.
After C3 the count is wrong, and the one new line is the only one with no instruction attached, in
the only place in the repo that instructs per header line. The generic sentence the spec is
paraphrasing ("hand over everything from the blank line onward") does survive — so this is not a
correctness break on the worker's prompt — but the spec is relying on a citation that does not say
what it is quoted as saying, and the file is one this task holds and is already editing. Nothing in
`test/prompts.test.ts` pins the "two header lines" wording, so nothing will catch the drift at
implement time either.

**Evidence.** `prompts/dispatch.md:26-28`, verbatim:

    brief, and anything you say here instead of in the issue is lost. When the brief came from `{{hpipe}} task`, the two header
    lines above it — `task_id:` and `files:` — are for you and not for the worker: confirm the `files:`
    line matches what you declared, then hand over everything from the blank line onward.

- "the two header lines" and the explicit pair `task_id:` and `files:` are the whole convention;
  there is no sentence generalising it to "every line above the blank line".
- Each named line gets an action: `files:` gets "confirm the `files:` line matches what you
  declared". C3's `bootstrap:` line arrives with none.
- `src/cli.ts:256` + `:260` + `:269` are the only emitters of those lines today, and C3 adds a third
  to both returns, so the count in the prose becomes stale the moment C3 lands.
- The ruling in the issue body makes the same loose paraphrase ("`prompts/dispatch.md:26-31` already
  documents that everything above the first blank line is for the orchestrator"). Inheriting it is
  understandable; propagating it into the spec's justification for not touching the sentence is not.
- Grepping the prompt tests for a pin on this wording finds nothing: the only `dispatch.md`
  assertion is `test/prompts.test.ts:60-66` (`worktree create --cwd {{repo_root}}`).

**Concrete fix.** Add to **C6**'s `prompts/dispatch.md` bullet, explicitly, that the existing
sentence at `:26-28` is amended in the same change: "the two header lines" → "the three header
lines", the enumeration → `task_id:`, `files:` and `bootstrap:`, and one clause giving `bootstrap:`
its action ("run the named script in the new checkout before `agent start`"). Then drop the "needs
no new convention" claim from C3 and replace it with "the convention exists and is extended by one
line in **C6**". Optionally add a `test/prompts.test.ts` assertion that `dispatch.md` names
`bootstrap:` alongside `task_id:` and `files:`, so the count cannot drift again; that file is already
in the Files table.

---

## MINOR 1 — the required live verification cannot run against the installed plugin, and the spec does not say what has to happen first

**Claim.** "**Live verification (required, not a test).** … On the next real batch in this repo,
whose `.claude/pipeline-bootstrap` **C6** ships: **the `hpipe task` output carries
`bootstrap: .claude/pipeline-bootstrap`** …"

**Problem.** Two preconditions gate that observation and neither is stated. (1) The plugin that
serves `hpipe task` and runs the supervisor is a GitHub install pinned to a commit, not this
checkout — so C1/C2/C3 are invisible until a release lands and the plugin is reinstalled. (2)
Detection reads `run.repo_root`'s working tree (**A13**), i.e. the primary checkout on `main` — so
`.claude/pipeline-bootstrap` only exists there after #16 merges. Until both hold, every bullet in the
checklist reads `bootstrap: none` and would be recorded as a pass by absence — the exact failure mode
the spec correctly calls out for pass 0's checklist. The obvious shortcut is forbidden:
`.claude/agents/plugin-dev.md:46-49` — "**Never link `src/cli.ts` onto your PATH, and never run the
checkout's `src/cli.ts` directly** against live state."

**Evidence.**

    $ herdr plugin list --json | …
    1.2.10 /Volumes/stein/.config/herdr/plugins/github/stein.pipeline-f39fb4f3495d
    {"kind": "github", "resolved_commit": "be181757beca96069b7f209163fb7538c0e6382f", …}

`be18175` is `main` (`git log --oneline -1 main` → `be18175 chore(main): release 1.2.10 (#50)`), i.e.
the installed copy predates this branch entirely. `.claude/agents/plugin-dev.md:40-51` calls this out
as "the self-hosting hazard" and the spec's own research records it at `research:§4`.

**Concrete fix.** Name the sequence in the live-verification block: merge #16 (second, per **A14**) →
release-please cuts a version → `herdr plugin install victorstein/herdr-plugin-pipeline` refreshes
the pinned copy → only then is the checklist observable. Add that a `bootstrap: none` reading before
that sequence completes is uninformative, not a failure.

---

## MINOR 2 — `cmdBrief`, the designed context-loss escape hatch, is silently excluded from the header line

**Claim.** C4: "One var added inside `renderWorkerPrompt` covers all three of its call sites —
`src/supervisor/tasks.ts:152`, `src/cli.ts:268` and `cmdBrief` at `src/cli.ts:286`." Nothing else in
the spec mentions `cmdBrief`.

**Problem.** `cmdBrief` gets the *worker* note but never the `bootstrap:` header line, and the spec
neither says so nor says why. Pass 0 flagged this call site by name as a hole in the old design; the
revision closes it for the worker text and leaves it open for the orchestrator text without
recording the choice. The exclusion is very probably correct — ruling condition (2) confines the
`src/cli.ts` edit to `cmdTask` around `:255-269`, and `cmdBrief` is a different function at
`:277-287` — but an implementer reading C3's "in both return statements" and C4's "all three call
sites" has no statement telling them to stop at two.

**Evidence.** `src/cli.ts:272-276` is the docstring that makes this the load-bearing case:

    /**
     * Read-only. Without it the only way to see a worker brief is to register a
     * task, which mutates the run — so an orchestrator that loses its context has
     * no way back to the text it is supposed to hand over. Measured on a live run.
     */

`prompts/dispatch.md:28-31` tells the orchestrator that `brief --task <id>` "prints the brief bare,
with no header lines and no `files:` echo, so hand that one over whole" — so the absence is already
documented for `files:` and would extend to `bootstrap:` by the same sentence.

**Concrete fix.** One line in **NG8** or a new non-goal: `cmdBrief` (`src/cli.ts:286`) keeps printing
the brief bare — no `bootstrap:` line — because ruling condition (2) confines the edit to `cmdTask`,
and `prompts/dispatch.md:28-31` already documents that `brief --task` carries no header lines. Say
explicitly that an orchestrator recovering context through `brief --task` must re-read the
`bootstrap:` line from its original `hpipe task` output or re-derive it from the repo.

---

## MINOR 3 — three citations in the `cmdTask`/`stall.ts` spine are off, two of them in the block the ruling confines the edit to

**Claim.** Problem section: "`enterTaskPhase(run, task, …, 'dispatched at registration')` at
`src/cli.ts:263`, then `renderWorkerPrompt` at `:268`". C3: "in both return statements — the `queued`
one at `:258` and the dispatched one at `:269`". Preamble: "The text builders in **C1** are modelled
on `src/supervisor/stall.ts:255-289` (`awaitingFor`)"; **A5** repeats "`awaitingFor`'s
`{short, clause}` pair".

**Problem.** `:258` is not a return statement, `:263` is not the `enterTaskPhase` call, and
`awaitingFor` is not a symbol in this codebase. The line numbers matter more than usual here because
ruling condition (2) scopes the permitted `src/cli.ts` edit by line range, and a reviewer at PR time
will diff against those numbers.

**Evidence.** `cat -n src/cli.ts`:

    258	  const gate = gateStatus(task, run.tasks)
    259	  if (gate.state !== 'ready') {
    260	    return ok(`task_id: ${task.task_id}\n${filesLine}\nqueued: waiting on ${gate.on.join(', ')}`)
    …
    263	  // The CLI is handing the prompt over now, so the task is dispatched. Leaving it
    265	  enterTaskPhase(run, task, taskRow('queued').onClear as TaskPhase, 'dispatched at registration')
    268	  const prompt = await renderWorkerPrompt(ctx.pluginRoot, run, task)
    269	  return ok(`task_id: ${task.task_id}\n${filesLine}\n\n${prompt}`)

So the queued return is `:260`, not `:258`, and `enterTaskPhase` is `:265`, not `:263` (`:263` is the
first line of its two-line comment — which is where the ruling's own `:263-269` range starts, so the
spec inherited an off-by-two). For `stall.ts`:
`grep -rn "awaitingFor" src/` → no output; the function spanning `:164-291` is
`export function stallAwaiting(run: Run, task: Task \| null, hpipe: string): Awaiting`
(`src/supervisor/stall.ts:164`). The cited *ranges* (`:255-289`, `:274-283`) are inside it and the
`{short, clause}` pair at `:274-283` is real, so only the name is wrong. Likewise C2's
`src/supervisor/tasks.ts:148-153`: `:148` is the `enterTaskPhase` call and the quoted `text:`
expression is `:150-152` inside a `prompts.push` at `:149-155`.

**Concrete fix.** `:258` → `:260`, `:263` → `:265` (or write `:263-269` as a block, matching the
ruling), `awaitingFor` → `stallAwaiting`, and `tasks.ts:148-153` → `tasks.ts:149-155` for the push /
`:150-152` for the `text:` expression.

---

## MINOR 4 — A13 covers the `none` mismatch in both directions but not the `not-executable` one, which C5 emits and the error table omits

**Claim.** **A13**: "A primary checkout parked on an unrelated branch renders a stale line — in
either direction … a false positive costs one skipped command rather than a halted batch. A false
negative reverts to today's behaviour." The error table has rows for "declared in `repo_root`'s
working tree but **absent from the new worktree**" and for a non-zero exit, and none for a mode
mismatch.

**Problem.** `repoBootstrap` has three states, and the working-tree-vs-ref hazard applies to the mode
bit exactly as it applies to existence. If the primary checkout's copy is mode `644` while the base
ref's is `755` — a local `chmod`, an `unzip`, a restored backup — the header line reads
`(NOT EXECUTABLE — chmod +x it on the base branch)` about a file that is already executable on the
base branch, and the remediation it prescribes is a no-op on a branch that detection never read. The
converse (executable locally, `644` on the base ref) renders a clean `ready` line and the orchestrator
hits `permission denied` — which is exactly the case **C5** exists to prevent, defeated by the same
mismatch **A13** was added for. Neither is catastrophic; both are unrecorded.

**Evidence.** §C1's state table emits `not-executable` from a working-tree mode test; **A13**'s "If
wrong" column discusses only presence/absence; §Error handling's mismatch row is scoped to
"**absent** from the new worktree". `src/lib/repo.ts:17-25` confirms there is no ref anywhere in the
value being tested.

**Concrete fix.** Extend **A13**'s "If wrong" column to name the mode case ("the same mismatch
applies to the executable bit: `not-executable` may be reported about a file that is `755` on the
base ref, and vice versa"), and add one error-table row: "Declared and executable in `repo_root`'s
working tree but `644` in the new worktree | Orchestrator gets `permission denied`; treat it as the
`not-executable` case and `chmod +x` on the base branch | **A13**".

---

## MINOR 5 — tests 10-13 are routed to the one CLI test file that never asserts `cmdTask` output shape, and the nearest existing examples are neither named nor declared

**Claim.** Testing strategy: "**`test/cli-commands.test.ts`** (this task's per the ruling; edits
appended …)" carries item 10 (`bootstrap:` on the dispatched return), 11 (on the queued return), 12
(the blank-line contract) and 13 (`bootstrap: none`).

**Problem.** `test/cli-commands.test.ts` is the *validation-failure* file — the spec's own research
says so. Every existing assertion about the `task_id:` / `files:` / `queued:` header lines, which is
precisely what items 10-13 extend, lives in `test/cli.test.ts` and `test/cli-argv.test.ts`. The
repo's definition of done requires naming the example mirrored (`prompts/worker-brief.md:63`,
`.claude/agents/plugin-dev.md:22`), and the spec names none for these four items. Choosing
`test/cli-commands.test.ts` is defensible — it is what the ruling grants, and neither alternative is
in #26's registered `--files` either — but the choice is unstated and the precedents are invisible to
the implementer, who will end up writing a fourth copy of a fixture that already exists twice.

**Evidence.** `research:§5d`: "Validation-style CLI failures are covered in
`test/cli-commands.test.ts`". The real precedents:

- `test/cli.test.ts:206-226` — "task echoes the file set it recorded while gated", asserting
  `task_id: t2`, `files: src/lib/gating.ts, src/cli.ts` and `queued: waiting on t1` — the exact
  fixture item 11 needs.
- `test/cli.test.ts:228-246` — "task echoes `files: none` on the dispatched return when nothing was
  declared", with the comment "The brief still follows, after the header lines" — the exact fixture
  items 10, 12 and 13 need.
- `test/cli-argv.test.ts:52-98` — the same contract through the real argv parser in a subprocess,
  with `fixture()` at `:20-35` already creating `<repo>/.claude/agents/core-dev.md`, one `mkdirSync`
  away from also creating `.claude/pipeline-bootstrap`.
- Neither file appears in §Files this change declares.

**Concrete fix.** Name `test/cli.test.ts:206-246` as the example items 10-13 are modelled on, and
state in one sentence why the new tests go to `test/cli-commands.test.ts` anyway (it is what the
ruling grants; `test/cli.test.ts` is held by neither task but was not granted). If `test/cli.test.ts`
is in fact the better home, add it to the Files table and say so — it is not in t1's registered
`--files`, so it collides with nothing.

---

The design's central choice is unchanged and correct, the pass-0 BLOCKER is genuinely closed on the
path that carries 85% of dispatches, and none of the above reverses a decision, changes scope, or
needs the human. MAJOR 1 is one sentence in `prompts/dispatch.md` — a file this task already holds
and already edits — plus deleting one false clause from C3.

VERDICT: CLEAR
