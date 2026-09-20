# Spec review 0 — issue #16 (`docs/superpowers/specs/2026-09-19-issue-16-design.md`)

Reviewed adversarially against `gh issue view 16`, `docs/superpowers/research/2026-09-19-issue-16-research.md`,
the code in this worktree, the installed `herdr 0.9.0`, and the live ledger under
`/Volumes/stein/.local/state/herdr/plugins/stein.pipeline/`.

**What checked out.** I re-verified the citation spine and it is unusually clean. `src/supervisor/tasks.ts:151-152`,
`src/lib/worker-prompt.ts:27-31,34-35`, `src/lib/render.ts:11`, `src/cli.ts:188-191,268,286`,
`src/lib/ledger.ts:29`, `src/lib/repo.ts:17-25`, `src/lib/config.ts:24`, `src/lib/herdr.ts:33-41`,
`src/hooks/_hook.ts:56,76-81`, `src/supervisor/tick.ts:164-176`, `src/supervisor/deliver.ts:113,259`,
`src/supervisor/stall.ts:250-289`, `test/tasks.test.ts:26`, `test/helpers/git-worktree.ts:12-16`,
`test/prompts.test.ts:16-24,68-76,88-100,140-148`, `.gitignore:1`, `package.json:10-12`,
`herdr-plugin.toml:6`, `prompts/dispatch.md:7-9`, `prompts/worker-brief.md:14` — all land where the spec says.
Pass 0 is correct (`ls docs/superpowers/reviews/ | grep issue-16` → exit 1, no output). The baseline
reproduces in this worktree: `bun test` → `503 pass / 0 fail / 1265 expect() calls`, `bun run typecheck` → exit 0.
`herdr worktree create --help` lists exactly `--workspace --cwd --branch --base --path --label --focus
--no-focus --trust-repository` and no post-create hook, so **NG1** and the rejected `[[build]]`
alternative hold. `.result.worktree.path` is real: the socket API's `worktree_created` success variant
requires `["type", "workspace", "tab", "root_pane", "worktree"]` (`herdr api schema --json`), and a
`WorktreeInfo` carries `path` (`herdr worktree list --cwd …` returns
`{"branch":"fix/16-worktree-bootstrap",…,"path":"/Volumes/stein/.herdr/worktrees/…"}`). **A10** is
right that nothing needs a `schema_version` bump, and **A11**'s reasoning about
`prompts/dispatch.md` tokens matches `src/lib/render.ts:11` and `src/supervisor/deliver.ts:246-259`.

The findings below are about where the mechanism is wired, not whether the mechanism is right.

---

## BLOCKER 1 — C2 instruments the dispatch path that carried 3 of the last 20 dispatches; the other 17 went through `hpipe task` and would never see the clause

**Claim.** C2: "`src/supervisor/tasks.ts:148-153` composes the per-task dispatch prompt today …
`dispatchClause(repoBootstrap(run.repo_root))` is inserted between the header line and the brief",
and the Goal section calls this "the per-task dispatch message the supervisor pushes to the
orchestrator … every single dispatch, with no orchestrator memory involved". C3 then dismisses
`src/cli.ts:268` as merely one of three "call sites" of `renderWorkerPrompt` that a new var covers
"for free".

**Problem.** `src/cli.ts:268` is not just a render site — it is a **second, independent dispatch
path**, and it is the dominant one. `cmdTask` dispatches a task inline at registration and hands the
orchestrator the brief directly; the supervisor's `queued` branch in `src/supervisor/tasks.ts:140-156`
then never runs for that task. C2 edits only the latter. On the registration path the orchestrator is
told nothing about the bootstrap except C5's static prose in `prompts/dispatch.md`, which the spec
explicitly scopes to "two static sentences **pointing at the per-task message**" — a message that
never arrives.

**Evidence.**

- `src/cli.ts:263-269`:

      enterTaskPhase(run, task, taskRow('queued').onClear as TaskPhase, 'dispatched at registration')
      await saveRun(ctx.stateDir, run)

      const prompt = await renderWorkerPrompt(ctx.pluginRoot, run, task)
      return ok(`task_id: ${task.task_id}\n${filesLine}\n\n${prompt}`)

  Any task whose gate is already `ready` at `hpipe task` time leaves `queued` here, so
  `src/supervisor/tasks.ts:140` (`if (task.phase === 'queued')`) never fires for it.
- Across every run on disk, counting task transitions out of `queued`:

      $ python3 … # over /Volumes/stein/.local/state/herdr/plugins/stein.pipeline/runs/*/*.json
      Counter({'dispatched at registration': 17, 'gate opened': 3})

  17 of 20 real dispatches took the `cmdTask` path C2 does not touch.
- Including **both tasks of the batch this spec is being written in**
  (`runs/pipeline/herdr-plugin-pipeline-20260919-stop-losing-reviews-and-broken-worktrees-wyy3.json`):

      {"at":1789857211623,"task_id":"t1","from":"queued","to":"research","why":"dispatched at registration"}
      {"at":1789857221974,"task_id":"t2","from":"queued","to":"research","why":"dispatched at registration"}

  The 16:34:12 → 16:34:26 → 16:34:35 window in `research:§2` — the very window the design is built
  around — is a `dispatched at registration` window. C2 would not have rendered a single character
  into it.
- The fallback is weaker than the defect. `prompts/dispatch.md` is rendered once, on the run's entry
  into `dispatch` (`src/supervisor/deliver.ts:259`), hours before the last `hpipe task` call. That is
  exactly the "knowledge lived in one agent's head for one session" failure mode the issue is filed
  over. And the designed context-loss escape hatch, `hpipe brief --task <id>`
  (`src/cli.ts:286`, documented at `prompts/dispatch.md:28-31`), renders only the worker brief — it
  carries C3's note and never C2's clause.

**Concrete fix — needs a decision, which is why this is a BLOCKER.** Three options, and they are not
equivalent:

1. **Render the clause in `cmdTask`'s output too**, as a third orchestrator-addressed header block
   above the `task_id:`/`files:` lines at `src/cli.ts:269`. This is the only option that keeps C1/C2/C4
   load-bearing on the real path — but `src/cli.ts` is #26's file this batch, so it needs coordination
   with the sibling or a re-slice of the holdings.
2. **Make `prompts/dispatch.md` self-contained** — static prose that names `.claude/pipeline-bootstrap`
   by convention and tells the orchestrator to run it if present, with no `{{token}}` (so **A11**
   survives) and no `hpipe` literal (so `test/prompts.test.ts:68-76` survives). This is inside this
   task's holdings, but it demotes C1/C2/C4: on 17/20 dispatches the plugin no longer detects anything,
   `dispatchClause` and the whole `not-executable` state never render, and the guarantee drops from
   "re-rendered every dispatch" to "stated once per run". That is a change to what the design claims,
   not a wording tweak.
3. **Fold the clause into `renderWorkerPrompt`'s return value** so all three call sites get it — but
   `prompts/dispatch.md:26-31` instructs the orchestrator to hand everything from the first blank line
   onward to the worker, so the clause would land in the worker's prompt, which is the wrong audience
   (and see MAJOR 2).

Pick one explicitly, then update the Goal's "every single dispatch" claim, the **Files this change
declares** table, and the live-verification checklist to match. The live check as written
("the per-task dispatch message in the orchestrator pane contains the clause") will not fire on a
normal batch and would be recorded as a pass by absence.

---

## MAJOR 1 — the declaration is detected in `run.repo_root`'s working tree but executed in a worktree cut from `main`; the design never states they must agree

**Claim.** C1: "**The path argument is always `run.repo_root`, an absolute path from the ledger
(`src/lib/ledger.ts:29`), never `process.cwd()`.** This is load-bearing". The flow section adds, in
passing, "The declaration is read at **prompt-render time**, once per dispatch, from `main`'s checkout."

**Problem.** `run.repo_root` is the *main checkout's root directory*, not `main` the *branch*. The
worktree the orchestrator is told to run the script in is created `--base main`
(`prompts/dispatch.md:8`). Nothing ties the two together: whatever branch the human happens to have
checked out in the primary working tree is what `existsSync`/`statSync` sees. The two can disagree in
both directions, and both are harmful:

- primary checkout on a feature branch that adds `.claude/pipeline-bootstrap`, `main` without it →
  the clause renders, the orchestrator runs `./.claude/pipeline-bootstrap` in a worktree that has no
  such file, gets `no such file or directory`, and C2's own instruction is *"If it fails, say so
  instead of starting the worker on a broken checkout"* — so **every task in the batch stalls at
  dispatch** on a purely spurious signal.
- primary checkout on a branch that lacks it, `main` with it → silent `{ kind: 'none' }`, and the
  issue's defect is back with no diagnostic (**A2** guarantees silence).

**Evidence.** `src/lib/repo.ts:17-25` derives `repoRoot` from `git rev-parse --show-toplevel` /
`--git-common-dir` — a *directory*, with no branch or ref in it — and that value is stored verbatim at
`src/lib/ledger.ts:29`. C4's own remediation text gives the game away: it tells the author to
`chmod +x` "**on `main`**", i.e. the design already knows the executed copy comes from `main`, while
`repoBootstrap` reads the working tree. Right now the two happen to agree here — `herdr worktree list`
shows `{"branch":"main",…,"path":"/Volumes/stein/Documents/development/personal/herdr-plugin-pipeline"}`
— but that is a coincidence of the current checkout, not an invariant, and no assumption records it.

**Concrete fix.** Keep the pure-fs detection (spawning `git cat-file -e main:.claude/pipeline-bootstrap`
would break C1's "never spawns anything" and the error-handling row that forbids throwing), and instead:

1. add an assumption — "**A13**: the declaration is read from `run.repo_root`'s *working tree*, which
   is assumed to be at or near the base the worktree is cut from; a primary checkout parked on an
   unrelated branch renders a stale clause" — and
2. make the C2 clause non-fatal on absence, so a stale detection degrades instead of halting the batch:
   *"if `.claude/pipeline-bootstrap` is not present in the new checkout, this repo's `main` does not
   declare one yet — skip it and start the worker."* Reserve the "say so instead of starting the
   worker" escalation for a non-zero exit of a script that actually exists.

---

## MAJOR 2 — inserting the clause "between the header line and the brief" breaks the blank-line convention the orchestrator uses to split orchestrator-text from worker-text

**Claim.** C2: "`dispatchClause(repoBootstrap(run.repo_root))` is inserted between the header line and
the brief."

**Problem.** The repo's own dispatch prompt already documents that the boundary between "text for you,
the orchestrator" and "text to hand to the worker" is a blank line, and already documents that this
heuristic is fragile. Dropping a multi-paragraph, blank-line-separated clause into exactly that seam
makes the first blank line in the supervisor's message fall *before* the clause instead of before the
brief, so the orchestrator-only instructions get pasted into the worker's initial prompt — where they
are unactionable (the worker cannot run something "before `agent start`") and where they compete with
C3's note for the same subject.

**Evidence.** `prompts/dispatch.md:23-31`:

> Hand the worker the brief exactly as you were given it. … When the brief came from `{{hpipe}} task`,
> the two header lines above it — `task_id:` and `files:` — are for you and not for the worker: …
> then hand over everything from the blank line onward. … `{{hpipe}} brief --task <id>` prints the
> brief bare, … its first blank line falls after the `# <branch> — issue #<n>` heading, and stripping
> to it would drop the heading.

That last sentence is this repo explicitly recording that the blank-line rule has already bitten once.
Today's supervisor message is `header\n\n<brief>` (`src/supervisor/tasks.ts:149-152`), which the rule
handles; `header\n\n<clause paragraphs>\n\n<brief>` is precisely the shape it mishandles.

**Concrete fix.** Do not put the clause inside the seam. Either emit it **after** the brief with an
explicit terminator, or keep it above the brief but make the boundary unambiguous in the rendered text —
e.g. end `dispatchClause` with a literal line such as `--- hand everything below this line to the
worker ---`, and add the matching sentence to the `prompts/dispatch.md` prose C5 already opens. Whichever
is chosen, add a `test/tasks.test.ts` assertion that the rendered brief's `# <branch> — issue #<n>`
heading is still reachable by the documented rule.

---

## MINOR 1 — `briefNote`'s `ready` text asserts something the design cannot guarantee

**Claim.** C3's worker text: "This worktree is bootstrapped by `./.claude/pipeline-bootstrap`, **run for
you before you started**."

**Problem.** **A8** concedes the mechanism "instructs; it does not enforce", and with BLOCKER 1 unfixed
it is not even instructed on 17/20 dispatches. A worker that reads a flat assertion that its checkout is
bootstrapped is being told the opposite of the failure mode C3 exists to catch. The next sentence
supplies the recovery, so it is recoverable — but the first sentence makes a worker likelier to
misdiagnose a genuine `command not found` as something else.

**Evidence.** Spec §C3 text vs §Assumptions **A8** ("An orchestrator that ignores the clause still
produces a broken worktree") and §Error handling row "Orchestrator skips the clause entirely".

**Concrete fix.** State the conditional, not the fact: "This repo declares a worktree bootstrap at
`./.claude/pipeline-bootstrap`, which should have been run in this checkout before you started. If a
build, test or typecheck fails on a missing dependency, run it yourself rather than installing anything
by hand."

## MINOR 2 — C4's "drop it" escape hatch contradicts A7

**Claim.** C4: "Drop it and `repoBootstrap` collapses to two states and **one `existsSync`**, mirroring
`src/cli.ts:188-191` exactly."

**Problem.** **A7** requires `statSync().isFile()` regardless of C4, precisely so a directory named
`pipeline-bootstrap` does not render as `ready` (and testing-strategy item 4 asserts it). Dropping C4
therefore does *not* collapse to one `existsSync` — it collapses to `existsSync` + `statSync().isFile()`.
Taking C4's sentence at face value during implementation would silently drop A7 and re-introduce the
directory bug the error-handling table's last row identifies.

**Evidence.** §C4 vs **A7** vs testing-strategy item 4. `src/cli.ts:188-191` really is a bare
`existsSync`, which is what makes the "mirroring … exactly" phrasing misleading.

**Concrete fix.** Reword C4's cost line to "Drop it and `repoBootstrap` collapses to two states,
`existsSync` plus the `isFile()` test **A7** requires either way."

## MINOR 3 — the last row of the error-handling table states the bug as the behaviour

**Claim.** Error handling, final row: "A directory at that path | `existsSync` true,
`statSync().mode & 0o111` true for a dir → would render `ready` | **A7**: also require `isFile()`".

**Problem.** Every other row's middle column is the *designed behaviour*; this one is the *defect if
A7 is not applied*, which contradicts testing-strategy item 4 (`directory → { kind: 'none' }`). An
implementer reading the table as a spec of behaviour will implement the wrong thing.

**Evidence.** §Error handling final row vs §Testing strategy item 4 vs **A7**.

**Concrete fix.** Rewrite the middle column as `{ kind: 'none' }` and move the `mode & 0o111`-on-a-
directory note into the Why column as the reason `isFile()` is required.

## MINOR 4 — the "Files this change declares" table does not match the task's registered `--files`, which is the only thing that actually enforces holdings

**Claim.** §Files this change declares, plus "`src/supervisor/tasks.ts:151` | mine" in `research:§8`.

**Problem.** Holdings are enforced by `gateStatus`/`filesOverlap` over `task.files`, not by prose. The
live ledger records this task's declaration as a largely disjoint set: it holds three prefixes the
design never touches, and declares none of the eight files the design does touch.

**Evidence.** `runs/pipeline/herdr-plugin-pipeline-20260919-…-wyy3.json`:

    t2 fix/16-worktree-bootstrap  files=['prompts/dispatch.md','src/hooks','README.md',
                                         'src/lib/config.ts','test/config.test.ts']
    t1 fix/26-verdict-overwrite   files=['src/supervisor/deliver.ts','test/deliver.test.ts',
                                         'src/cli.ts','test/cli-commands.test.ts']

Only `prompts/dispatch.md` and `README.md` overlap the design's table. `src/lib/bootstrap.ts`,
`src/supervisor/tasks.ts`, `src/lib/worker-prompt.ts`, `prompts/worker-brief.md`, `test/prompts.test.ts`,
`test/tasks.test.ts`, `test/bootstrap.test.ts` and `.claude/pipeline-bootstrap` are undeclared, while
`src/hooks`, `src/lib/config.ts` and `test/config.test.ts` are held and unused. No collision exists in
*this* two-task batch — #26's set is disjoint — so this is a MINOR, but the spec's ownership argument
rests on prose the gate does not back, and it is the same defect class as the `--files` findings
already recorded for this pipeline.

**Concrete fix.** Note in the Files section that the registered `--files` differ, and say explicitly
that the holdings relied on are the batch's stated split rather than the ledger's; or surface a decision
to re-register the task's `--files` to match the table.

---

The core judgement in this spec — repo-declared script, plugin reads and names it, plugin never executes
it (**NG1**, **A1**, **A3**, **A8**) — is well evidenced and I would not change it. BLOCKER 1 is about
*where* that reading is wired in, and it is a decision about scope and file ownership that cannot be made
without the human or the sibling task.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 2
