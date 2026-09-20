# Design — issue #16: fresh worktrees are not bootstrapped

Revision after the **post-rewind** spec review
(`docs/superpowers/reviews/issue-16-spec-review-0.md`, VERDICT: CLEAR — 0 BLOCKERs / 1 MAJOR /
5 MINORs, all fixed inline here), which followed **pass 0**'s
(`docs/superpowers/reviews/issue-16-spec-review-pass0-preserved.md`, VERDICT: BLOCKER — 1 BLOCKER /
2 MAJORs / 4 MINORs) and the **Ownership ruling — `src/cli.ts`, 2026-09-19** at the bottom of
`gh issue view 16`. All thirteen findings are accepted; nothing is partially applied. What changed
and why is the next two sections.

The review file was renamed from `issue-16-spec-review-0.md` before this revision: the rewind into
`spec` resets this task's pass counter, so the next verdict would be written to the pass-0 path and
overwrite it. That collision is issue #26, mid-flight in this same batch; until it lands the rename
is manual (`78447de`).

Builds on `docs/superpowers/research/2026-09-19-issue-16-research.md`, cited as `research:§n`.

**Modelled on `docs/superpowers/specs/2026-09-18-issue-21-design.md`** for section order and on
`docs/superpowers/specs/2026-09-18-issue-19-design.md` for the *What changed* disposition table that
a revision pass owes its reviewer. The text builders in **C1** are modelled on
`src/supervisor/stall.ts:255-289`, inside `stallAwaiting` (`src/supervisor/stall.ts:164`); the header-line emission in **C3** is modelled on
`filesLine` at `src/cli.ts:252-255`, which is the specific idiom the ruling directs this work to
mirror.

Baseline re-verified in this worktree at `78447de`: `bun test` → **503 pass / 0 fail**, 1265
`expect()` calls across 34 files; `bun run typecheck` → clean, exit 0. The pass-0 reviewer re-ran
both independently and got the same.

---

## What changed from the post-rewind review

It returned **CLEAR**, having re-derived all seven pass-0 findings against the spec's current text
rather than trusting the disposition table below, and having found six genuinely applied and one
half-applied. Its six findings are fixed here.

| Finding | Disposition |
| --- | --- |
| **MAJOR 1** — C3 claimed `prompts/dispatch.md` "already tells the orchestrator that the lines above the blank line are for you", so the header line "needs no new convention". The prose at `:26-28` in fact says "the **two** header lines above it — `task_id:` and `files:`" and attaches a per-line action to each; C6 never scheduled that sentence for amendment | **Accepted — the citation did not say what I quoted it as saying.** C3 no longer claims the convention is free: it is *extended by one line*, and **C6** now amends `:26-28` in the same change (count → three, enumeration gains `bootstrap:`, and `bootstrap:` gets its own action beside `files:`'s). Testing item 21 pins it so the count cannot drift again. The generic "hand over everything from the blank line onward" rule is what actually keeps the worker's prompt correct, and that part is untouched. The ruling in the issue body makes the same loose paraphrase, which is where I inherited it. |
| **MINOR 1** — the live-verification checklist cannot run at all until a release ships and the pinned plugin is reinstalled; unstated, so every bullet would read `bootstrap: none` and be recorded as a pass by absence | **Accepted.** The block now states both preconditions (`resolved_commit be181757…` predates this branch; detection needs `.claude/pipeline-bootstrap` on `main`), names the sequence merge → release → `herdr plugin install` → observe, and says outright that a `bootstrap: none` reading before that is uninformative rather than a failure. This is the same pass-by-absence trap the checklist was rewritten to fix for pass 0 — caught here on its second instance. |
| **MINOR 2** — `cmdBrief` silently gets the worker note but not the header line | **Accepted.** New **NG9** states the exclusion, both binding reasons (ruling condition (2); `prompts/dispatch.md:28-31` already documents `brief --task` as carrying no header lines), and the real consequence for an orchestrator recovering context through it. |
| **MINOR 3** — three citations wrong, two inside the line range the ruling scopes the edit by | **Accepted, all verified against the source.** `src/cli.ts:258` → `:260` (the queued return), `:263` → `:265` (`:263` is the first line of its comment — the ruling's own range start, which is where the off-by-two came from), `awaitingFor` → `stallAwaiting` (`src/supervisor/stall.ts:164`; `grep -rn awaitingFor src/` → no output), `tasks.ts:148-153` → `:149-155` for the push. |
| **MINOR 4** — **A13** covered the working-tree-vs-ref mismatch for existence but not for the executable bit, which **C5** also reads from the working tree | **Accepted.** **A13** now names both mode directions, and the error table gains two rows: a `755` working-tree copy against a `644` base ref (which defeats the case **C5** exists to prevent), and `not-executable` reported about a file that is `755` on the base ref (a no-op remediation). |
| **MINOR 5** — tests 10-13 are routed to `test/cli-commands.test.ts`, the validation-failure file, while the actual precedents for `cmdTask` output-shape assertions live in `test/cli.test.ts:206-246`, named nowhere | **Accepted, with the routing kept.** `test/cli.test.ts:206-246` is now named as the modelled example, fixture by fixture, plus `test/cli-argv.test.ts:52-98`. The tests still go to `test/cli-commands.test.ts` because that is what the ruling grants; taking `test/cli.test.ts` would collide with nothing but would widen the grant without a ruling, which is the habit this batch is trying to break. If the plan phase disagrees, that is a decision to surface. |

**What the post-rewind review confirmed, and what is therefore not re-litigated.** It independently
reproduced the 17-vs-3 dispatch count, the 503/0 baseline and the clean typecheck; confirmed
`deliver.ts:250-255` passes only `{run_id, title, pass, verdict_path, repo_root}` to the `dispatch`
render, so **A11**'s no-new-token constraint is correct; confirmed `src/lib/repo.ts:17-25` yields a
directory with no ref, so **A13** is the right shape; confirmed `.claude/` is tracked, so shipping
`.claude/pipeline-bootstrap` works; and confirmed that every existing `files:` assertion is
`toContain` (`test/cli.test.ts:224,243`, `test/cli-argv.test.ts:57,67,97`), so a third header line
breaks none of them. It stated it would not change the central judgement.

## What changed from the pass-0 review

| Finding | Disposition |
| --- | --- |
| **BLOCKER 1** — C2 instrumented the supervisor's `queued` branch, which carried 3 of the last 20 dispatches; the other 17 went through `cmdTask`'s inline path and would never see the clause | **Accepted, fixed per the ruling.** `src/cli.ts` and `test/cli-commands.test.ts` are granted to this task, confined to the `cmdTask` header-line emission around `:255-269`. New **C3** covers the registration path; **C2** keeps the supervisor path; both read the one detector in **C1**. The Goal, the Files table and the live-verification checklist are restated to match. Merge-second conditions are recorded in **A14**. |
| **MAJOR 2** — inserting a multi-paragraph clause "between the header line and the brief" lands orchestrator-only text inside the blank-line seam `prompts/dispatch.md:23-31` documents as having already bitten once | **Accepted, and it reshaped the design rather than being patched.** The per-dispatch output is now a **single header line** in the `files:` shape on *both* paths, so the first blank line still falls immediately before the brief and the seam is untouched. The multi-paragraph *procedure* moves to static prose in `prompts/dispatch.md` (**C6**), which carries no `{{token}}` and so keeps **A11**. This is what made the fix for BLOCKER 1 cheap: a header line is the same shape on both paths. |
| **MAJOR 1** — detection reads `run.repo_root`'s *working tree*; the script executes in a worktree cut `--base main`, and the two can disagree in both directions | **Accepted.** New **A13** states the assumption outright, and the **C6** procedure is made non-fatal on absence: a missing script in the new checkout means "skip it and start the worker", and only a non-zero exit of a script that *exists* justifies halting. C5's remediation text no longer says "on `main`" as though detection read `main`. |
| **MINOR 1** — `briefNote`'s "run for you before you started" asserts what **A8** concedes is unguaranteed | **Accepted.** Reworded to the conditional, verbatim from the reviewer's suggested text (**C4**). |
| **MINOR 2** — C4's "drop it and it collapses to one `existsSync`" contradicts **A7**, which requires `isFile()` either way | **Accepted.** The cost line in **C5** now reads "`existsSync` plus the `isFile()` test **A7** requires either way", and no longer claims to mirror `src/cli.ts:188-191` "exactly". |
| **MINOR 3** — the error table's last row stated the *defect* in the behaviour column, contradicting testing item 4 | **Accepted.** The row's behaviour column is now `{ kind: 'none' }` and the `mode & 0o111`-on-a-directory fact moved to the Why column. |
| **MINOR 4** — the declared-files table is largely disjoint from the task's registered `--files` in the live ledger | **Accepted.** The Files section now prints the ledger's actual sets, states that the holdings relied on are the batch's stated split plus the ruling — not the gate — and names #37. Re-registering is not possible: no command amends `task.files`. |
| — | **Also changed:** **A2** is reversed. Absence is now *echoed* (`bootstrap: none`), not silent, because `filesLine`'s own comment at `src/cli.ts:252-255` is this repo's recorded reasoning for exactly that choice. Recorded and justified under **A2**. |

**What the review confirmed, and what is therefore not re-litigated.** The reviewer re-verified the
whole citation spine (~20 `file:line` claims, listed at review `:6-25`), the absence of any
post-create hook in `herdr worktree create --help`, the `worktree_created` response shape via
`herdr api schema --json`, and the 503/0 + clean-typecheck baseline. **NG1**, the rejected
`[[build]]` alternative, **A10** (no `schema_version` change) and **A11** all held. The core
judgement — repo-declared script, plugin names it, plugin never executes it — was explicitly not
disputed.

---

## Problem

`herdr worktree create` hands a worker a bare `git` checkout. Every input a repo does not track is
absent: `node_modules`, `.venv`, submodules, generated `dist`. The worker only discovers this when
its first build runs — which in this pipeline is at `implement`, hours after dispatch, for every
task in the batch at once.

It is real here, not only on berean-os. `git archive HEAD | tar -x` into a clean directory — exactly
the tracked-file set a fresh worktree has — then (`research:§1`):

    $ bun run typecheck
    $ tsc --noEmit
    /opt/homebrew/bin/bash: line 1: tsc: command not found
    error: script "typecheck" exited with code 127

`node_modules/` is ignored (`.gitignore:1`) and `tsc` is a devDependency (`package.json:10-11`), so
the gate `.claude/agents/plugin-dev.md` makes non-negotiable before every push cannot pass until
someone runs `bun install`.

**Someone is already doing that by hand, on every worktree, silently.** Three clocks on *this*
worktree agree (`research:§2`):

| Time | What | Source |
| --- | --- | --- |
| 16:34:12 | `worktree.created` hook fires; git writes the tree | `herdr plugin log list` → `plugin-log-377`, `finished_unix_ms 1789857252078`; `stat` on `package.json` |
| 16:34:26 | `node_modules` appears — a hand-run `bun install` | `stat -f '%Sm' node_modules` |
| 16:34:35 | `pane.agent_detected` — the worker boots | `plugin-log-379`, `finished_unix_ms 1789857275268` |

Fourteen seconds of orchestrator memory, in a 23-second window, repeated per worktree per batch,
and gone when that session ends. That is the defect: not that bootstrapping is hard, but that the
knowledge of *what to run* lives nowhere the pipeline can read.

**The plugin is not in that window.** Nothing in `src/` creates a worktree — `grep -rn "worktree" src/`
finds only removal (`src/lib/herdr.ts:115-117`, used by `src/supervisor/teardown.ts:24-35`). The
orchestrator *agent* runs both `worktree create` and `agent start`, in one turn, instructed by
`prompts/dispatch.md:7-9`. The plugin learns about the worktree afterwards: the hook only enqueues
(`src/hooks/_hook.ts:76-81` → `src/lib/queue.ts:20-28`) and adoption happens on a later supervisor
tick (`src/supervisor/tick.ts:165-175`) — measured 23s after the agent was already detected
(`research:§3`). herdr offers nothing of its own: `herdr worktree create --help` has no post-create
hook, and `[[build]]` runs only on GitHub `plugin install`, never on `plugin link`, gets no runtime
context, and runs in the *plugin's* directory (`research:§4`).

**And there are two dispatch paths, not one.** This is what pass 0 got wrong and what the ruling
settles. `cmdTask` dispatches a ready task inline at registration —
`enterTaskPhase(run, task, …, 'dispatched at registration')` at `src/cli.ts:265`, then
`renderWorkerPrompt` at `:268` — so the supervisor's `queued` branch at `src/supervisor/tasks.ts:140`
never fires for it. Counted over every run on disk:

    $ grep -rho '"why": *"[^"]*"' ~/.local/state/herdr/plugins/stein.pipeline/runs | sort | uniq -c | sort -rn
      …
      17 "why": "dispatched at registration"
      …
       3 "why": "gate opened"

Both tasks of the batch this issue is being worked in took the registration path, including the
16:34 window above. A mechanism wired only into the supervisor branch would be dead on 85% of real
dispatches.

## Goal

A repo declares, once and in its own tree, the command that makes a fresh checkout workable. The
pipeline detects that declaration and echoes it as **one header line on every dispatch, by both
dispatch paths**, with no orchestrator memory involved:

1. `cmdTask`'s inline registration output (`src/cli.ts:255-269`) — the path that carried 17 of the
   last 20 dispatches.
2. The supervisor's per-task dispatch message (`src/supervisor/tasks.ts:149-155`) — the path for a
   task whose gate opens later.

The standing *procedure* — run it in the new checkout after `worktree create`, before `agent start` —
lives in `prompts/dispatch.md`, where it is stable prose rather than per-repo data.

The worker's own brief (`prompts/worker-brief.md`) names the same script as its recovery, so a worker
whose checkout was not bootstrapped has a one-command fix instead of an unexplained
`command not found`.

This repo ships its own declaration as part of the change, so the next batch driven here is
bootstrapped by the mechanism rather than by hand.

## Non-goals

- **NG1 — the plugin does not execute the bootstrap.** Not from the `worktree.created` hook: hooks
  "only enqueue; they must never block" (`.claude/agents/plugin-dev.md`), and a `uv sync` there would
  hold a herdr plugin-command slot for minutes. Not from the supervisor: `TICK_MS` is 1000
  (`src/lib/config.ts:24`) and adoption lands *after* `agent start` (`research:§3`), so it would race
  the worker it is meant to precede. See Rejected alternatives.
- **NG2 — no *rejection* at registration.** **C3** echoes what it detected; it never fails `cmdTask`.
  A repo that legitimately needs no bootstrap must register tasks normally. (Pass 0 listed this as
  out of scope because `src/cli.ts` was the sibling's; it is now in scope and the answer is still
  "echo, do not reject".)
- **NG3 — `dist_note` is left alone.** `src/lib/worker-prompt.ts:27-31` hardcodes a
  `pnpm install && pnpm turbo build --filter=@repo/core` note and fires on `depends_on` a `core`
  surface, not on anything a repo declares. It is *task-conditional*, so a repo-level bootstrap
  cannot express it and does not subsume it. Same disease, its own issue; removing it here would
  silently drop behaviour some repo depends on. Recorded as **A9**.
- **NG4 — no config file format, and no parser.** The README states the plugin has no runtime
  dependencies (`README.md:29-31`) and `bun.lock` confirms it.
- **NG5 — no verification that the bootstrap ran, or succeeded.** Nothing generic can know what
  "bootstrapped" looks like across repos, and the plugin has no execution point (**NG1**). **A8**
  records what that does and does not guarantee.
- **NG6 — teardown is untouched.** `src/supervisor/teardown.ts` and `worktreeRemove` do not change.
- **NG7 — Windows.** `herdr-plugin.toml:6` declares `platforms = ["macos", "linux"]`.
- **NG8 — `cmdRewind` is not touched.** Ruling condition (2): #26's `src/cli.ts` work is in
  `cmdRewind`, and this change stays inside `cmdTask`.
- **NG9 — `cmdBrief` keeps printing the brief bare.** It gets **C4**'s worker note, because it calls
  `renderWorkerPrompt`, but **not** the `bootstrap:` header line. Two binding reasons: ruling
  condition (2) confines the `src/cli.ts` edit to `cmdTask`, and `cmdBrief` is a different function
  at `:277-287`; and `prompts/dispatch.md:28-31` already documents that `brief --task <id>` "prints
  the brief bare, with no header lines and no `files:` echo", which extends to `bootstrap:` by the
  same sentence. The consequence is stated here rather than discovered later: an orchestrator
  recovering context through `brief --task` — the documented escape hatch, whose docstring at
  `src/cli.ts:272-276` exists because otherwise "an orchestrator that loses its context has no way
  back to the text it is supposed to hand over" — must re-read the `bootstrap:` line from its
  original `hpipe task` output, or re-derive it from the repo.

## Architecture

Six components. **C5 is the most droppable** and is marked so.

### C1 (load-bearing) — `src/lib/bootstrap.ts`, a new pure lib module

One new module in `src/lib/`, the pure core, with one test file — the layout
`.claude/agents/plugin-dev.md` prescribes. Modelled on `src/lib/repo.ts` for size and single purpose,
and on `src/supervisor/stall.ts:255-289` for shape: a state value plus sibling functions that compose
the agent-facing text.

    export const BOOTSTRAP_REL = '.claude/pipeline-bootstrap'

    export type Bootstrap =
      | { kind: 'none' }
      | { kind: 'ready' }
      | { kind: 'not-executable' }

    export function repoBootstrap(repoRoot: string): Bootstrap
    export function bootstrapLine(b: Bootstrap): string   // ONE line, for the orchestrator
    export function briefNote(b: Bootstrap): string       // for the worker

`repoBootstrap` is `existsSync`, then `statSync().isFile()` (**A7**), then a mode-bit test, on
`join(repoRoot, BOOTSTRAP_REL)`. It never reads the file, never spawns anything, and never throws — a
`statSync` failure degrades to `{ kind: 'none' }`.

`bootstrapLine` returns exactly one line with no trailing newline, in the `files:` shape:

| state | line |
| --- | --- |
| `none` | `bootstrap: none` |
| `ready` | `bootstrap: .claude/pipeline-bootstrap` |
| `not-executable` | `bootstrap: .claude/pipeline-bootstrap (NOT EXECUTABLE — chmod +x it on the base branch)` |

**The path argument is always `run.repo_root`, an absolute path from the ledger
(`src/lib/ledger.ts:29`), never `process.cwd()`.** herdr runs plugin commands "with the plugin
directory as their working directory" (v0.9.1 plugins doc), so the supervisor's cwd is the *plugin*
root, and `cmdTask`'s is wherever a human typed it. `run.repo_root` is the only value all three
processes agree on — the same reason `src/supervisor/tasks.ts:103` and `src/supervisor/deliver.ts:113`
already key off it. What it does **not** pin is a git ref: see **A13**.

### C2 — the supervisor's dispatch message carries the line

`src/supervisor/tasks.ts:149-155` composes the per-task dispatch prompt today:

    text: `Dispatch ${task.task_id} (${task.branch}, #${task.issue}) — ` +
      `worktree create --cwd ${run.repo_root}:\n\n` +
      (await renderWorkerPrompt(deps.pluginRoot, run, task)),

`bootstrapLine(repoBootstrap(run.repo_root))` becomes a second header line, so the message is
`header\nbootstrap: …\n\n<brief>`. **The single `\n\n` before the brief is preserved**, which is the
whole point of MAJOR 2's fix: `prompts/dispatch.md:23-31` documents that everything from the first
blank line onward is handed to the worker, and a header line does not move that boundary.

### C3 (the ruling) — `cmdTask`'s registration output carries the same line

This is the path that actually dispatches. `src/cli.ts:252-269` already emits orchestrator-only
header lines above the blank line and already documents why:

    // The recorded set, printed back. A malformed --files is otherwise invisible:
    // … so a declaration that matches nothing is silent by construction.
    const filesLine = `files: ${task.files.length > 0 ? task.files.join(', ') : 'none'}`

A `bootstrapLine` is emitted beside it, in both return statements — the `queued` one at `:260` and
the dispatched one at `:269` — so the orchestrator sees it whether or not the task dispatches
immediately. The shape becomes:

    task_id: t2
    files: …
    bootstrap: .claude/pipeline-bootstrap

    # fix/16-worktree-bootstrap — issue #16
    …

`prompts/dispatch.md:26-28` already establishes this convention — but it establishes it *by name and
count*: "the **two** header lines above it — `task_id:` and `files:`", with a per-line action
attached to each. A third line makes that sentence stale, so **the convention is not free: it is
extended by one line, and C6 amends that prose in the same change.** What survives untouched is the
generic rule in the same sentence — "hand over everything from the blank line onward" — which is what
keeps the worker's prompt correct, and no `{{token}}` is needed either way (**A11**).

**Holdings.** `src/cli.ts` and `test/cli-commands.test.ts` are this task's per the ruling. Edits are
confined to `cmdTask` around `:255-269`; `cmdRewind` is not touched (**NG8**); this task merges
second (**A14**).

### C4 — the worker is told, as its recovery path

`src/lib/worker-prompt.ts:16-32` gains one var,

    bootstrap_note: briefNote(repoBootstrap(run.repo_root)),

and `prompts/worker-brief.md` gains `{{bootstrap_note}}` immediately after `{{dist_note}}`
(`worker-brief.md:14`), the existing slot for a conditional environment note. `briefNote` returns
`''` when nothing is declared — the same empty-string convention `dist_note` uses
(`worker-prompt.ts:31`). The `ready` text, stated conditionally per MINOR 1:

    > This repo declares a worktree bootstrap at `./.claude/pipeline-bootstrap`, which should have
    > been run in this checkout before you started. If a build, test or typecheck fails on a missing
    > dependency, run it yourself rather than installing anything by hand.

One var added inside `renderWorkerPrompt` covers all three of its call sites —
`src/supervisor/tasks.ts:152`, `src/cli.ts:268` and `cmdBrief` at `src/cli.ts:286`. `vars` is passed
to both the `worker-brief` and `research` renders (`worker-prompt.ts:34-35`); extra vars are ignored
and only a *missing* one throws (`src/lib/render.ts:11`), so adding a key is safe for both.

### C5 (most droppable) — the `not-executable` state

`git` records the executable bit, but only if it is set when the file is first added, and adding
`.claude/pipeline-bootstrap` without `chmod +x` is a routine mistake. Without this branch the
orchestrator gets a bare `permission denied` mid-dispatch; with it the header line names the fix.

Cost: one mode-bit test and one string. Drop it and `repoBootstrap` collapses to two states —
`existsSync` plus the `isFile()` test **A7** requires either way (MINOR 2). Nothing else depends on
it.

### C6 — the procedure, this repo's own script, and the README contract

- **`prompts/dispatch.md`** is amended in **two** places. First, the sentence at `:26-28` — the only
  place in the repo that instructs the orchestrator *per header line* — is corrected: "the two header
  lines" → "the three header lines"; the enumeration becomes `task_id:`, `files:` and `bootstrap:`;
  and `bootstrap:` gets an action of its own beside `files:`'s "confirm the `files:` line matches
  what you declared" — namely *run the named script in the new checkout before `agent start`*.
  Leaving the count stale is how a convention silently drifts, and nothing pins that wording today
  (`test/prompts.test.ts`'s only `dispatch.md` assertion is `:60-66`), so testing item 21 adds the
  pin. Second, it gains a short static subsection: what the `bootstrap:` header line means,
  that the script is run **in the new checkout** after `worktree create` and before `agent start`
  (`(cd "<.result.worktree.path>" && ./.claude/pipeline-bootstrap)`), and — per MAJOR 1 — that a
  script **absent from the new checkout is skipped, not escalated**; only a non-zero exit of a script
  that exists justifies not starting the worker. **No new `{{token}}`**: its render site is
  `src/supervisor/deliver.ts:259`, the sibling's file, and a token with no matching var throws at
  delivery in front of an agent (`src/lib/render.ts:11`) (**A11**).
- **`.claude/pipeline-bootstrap`**, mode `755`:

      #!/bin/sh
      # A fresh worktree has no node_modules and `bun run typecheck` needs tsc from it.
      set -e
      bun install

  `research:§1` proves this repo needs it; shipping it means the mechanism is exercised by the next
  batch driven here, not only by tests.
- **`README.md`** gains a subsection under **Install** stating the contract: the path, that it must
  be executable, that it runs from the worktree root, that it must be idempotent (**A6**), and that a
  repo needing nothing simply omits it. README content is already test-covered
  (`test/prompts.test.ts:88-100`).

## Data and control flow

Unchanged parts are marked (=). **Both dispatch paths now carry the line.**

    PATH A — registration (17 of the last 20 dispatches)
    (=) hpipe task …                                   src/cli.ts:165-269
         ├─ NEW: repoBootstrap(run.repo_root) → bootstrapLine(...)
         ├─ (=) gate not ready  → "task_id: / files: / bootstrap: / queued: waiting on …"   :260
         └─ (=) gate ready      → enterTaskPhase(… 'dispatched at registration')            :265
                                  "task_id: / files: / bootstrap:" + "\n\n" + brief         :269

    PATH B — supervisor, for a task whose gate opens later (3 of 20)
    (=) gate opens for a queued task                   src/supervisor/tasks.ts:139-147
         ├─ NEW: repoBootstrap(run.repo_root) → bootstrapLine(...)
         └─ (=) prompt to run.orchestrator_pane:
                "Dispatch … worktree create --cwd <root>:" + "\n" + bootstrap line
                                                       + "\n\n" + renderWorkerPrompt(...)  :149-155

    BOTH → renderWorkerPrompt                          src/lib/worker-prompt.ts:10-36
         └─ NEW: briefNote(...) → {{bootstrap_note}}   prompts/worker-brief.md:15

    (=) orchestrator: herdr worktree create --cwd <repo_root> --branch <b> --base main
         │            → .result.worktree.path, .result.root_pane.pane_id
         ├─ NEW (procedure from prompts/dispatch.md, C6):
         │     (cd "<.result.worktree.path>" && ./.claude/pipeline-bootstrap)
         │     absent → skip and continue;  non-zero exit → stop and report      (MAJOR 1)
    (=) orchestrator: herdr agent start … --pane <root_pane_id> -- "<brief>"
         ▼
    (=) worker's first turn: research. The brief names the bootstrap as its recovery.

    (=) in parallel: worktree.created → hook enqueues → tick.ts:165-175 adopts, ~23s later.
        Untouched.

The declaration is read at output-composition time, once per dispatch. A repo that adds or changes
its bootstrap picks it up on the next task dispatched; nothing is cached, no ledger field is added,
and **`schema_version` does not change** — so runs already on disk are unaffected (the hazard
`.claude/agents/plugin-dev.md` calls out).

## Error handling

| Condition | Behaviour | Why |
| --- | --- | --- |
| No `.claude/pipeline-bootstrap` under `repo_root` | `bootstrap: none`; `briefNote` → `''` | Echoing absence is the `filesLine` precedent (`src/cli.ts:252-255`); a silent nothing is indistinguishable from a detector that failed (**A2**) |
| Declared and executable | `bootstrap: .claude/pipeline-bootstrap`; brief note renders | The intended path |
| Declared, not executable | Line carries `(NOT EXECUTABLE — chmod +x it on the base branch)`; brief note says the same | Turns `permission denied` into a named fix (**C5**) |
| Declared in `repo_root`'s working tree but **absent from the new worktree** | Orchestrator skips it and starts the worker; no escalation | **A13**: detection sees a working tree, not the base ref. Halting a whole batch on a stale detection is worse than the defect (MAJOR 1) |
| Declared and executable in `repo_root`'s working tree but `644` in the new worktree | Orchestrator gets `permission denied`; treat it as the `not-executable` case and `chmod +x` on the base branch | **A13**: the mode bit is read from the working tree, exactly like existence, so **C5** cannot catch this one |
| Reported `not-executable` but `755` on the base ref | The `chmod +x` remediation is a no-op; the script runs | **A13**, the same mismatch the other way. Harmless noise, recorded so it is not re-diagnosed |
| Script exists in the worktree and exits non-zero | Orchestrator stops and reports; worker not started | The only case where halting is justified (**C6**) |
| A **directory** at that path | `{ kind: 'none' }` | `existsSync` is true and `mode & 0o111` is set on a directory, so `isFile()` is what excludes it (**A7**; MINOR 3) |
| `repoRoot` missing, or `statSync` throws (EACCES, ELOOP, dangling symlink) | Caught → `{ kind: 'none' }` | `renderWorkerPrompt` and `cmdTask` must never throw: both are on the dispatch path. `src/lib/herdr.ts:33-41` sets the precedent — degrade, never crash the supervisor loop |
| Orchestrator ignores the header line entirely | Worker hits it at `implement`; the brief names the fix (**C4**) | Accepted residual risk — **A8** |

## Assumptions

| # | Assumption | If wrong |
| --- | --- | --- |
| **A1** | The declaration is an **executable script at `<repo_root>/.claude/pipeline-bootstrap`**, not a command string in a config file. Mirrors the one per-repo-config precedent, `src/cli.ts:188-191`'s `<repo_root>/.claude/agents/<surface>-dev.md`. Needs no parser (**NG4**), handles multi-step bootstraps, is reviewable in PRs, and a human can run it directly | A config key would need a format and a parser; a one-line command would not cover berean-os's submodules-plus-`uv sync` case |
| **A2** | **Absence is echoed, not silent** — `bootstrap: none`. *Reversed from pass 0.* `filesLine`'s own comment (`src/cli.ts:252-255`) is this repo's recorded reasoning for echoing recorded state: a declaration that matches nothing is otherwise "silent by construction". One word is not nagging, and it distinguishes "this repo declares none" from "the detector did not run" | If it reads as noise, drop it from **C2** only and keep it on **C3**, where the `files:` precedent is literally adjacent |
| **A3** | **The orchestrator runs it, between `worktree create` and `agent start`.** Taken from the issue's Directions — *"run after `worktree create` and before the worker starts"* — and it is the window the hand-fix actually used (`research:§2`) | The alternative is the worker's first turn, which leaves the worktree broken for anything the orchestrator does in between, and contradicts the issue |
| **A4** | **The worker is told too**, as recovery, not as a second execution | Unconditional re-running would be safe (**A6**) but doubles `npm ci`-class cost on every task |
| **A5** | **Two renderers, one reader.** `bootstrapLine` and `briefNote` over one `Bootstrap`, following `stallAwaiting`'s `{short, clause}` pair at `src/supervisor/stall.ts:274-283` | One shared string would be wrong for one of the two audiences |
| **A6** | **The script must be idempotent**, stated in the README contract. `bun install`, `npm ci`, `uv sync`, `git submodule update --init` all are | A worker following **C4**'s recovery could damage its checkout |
| **A7** | `repoBootstrap` requires a **regular file** (`statSync().isFile()`) before the mode test | A directory named `pipeline-bootstrap` would render as `ready` |
| **A8** | The mechanism **instructs; it does not enforce.** The durability win is that the knowledge is in the repo and re-rendered on every dispatch by both paths, not that execution is guaranteed. There is no non-agent executor in that window (**NG1**) | If enforcement is required, the answer is a herdr feature request, not a plugin change |
| **A9** | `dist_note` stays (**NG3**); both notes can render, producing two blockquotes | If they stack badly, the fix is ordering in `worker-brief.md`, not merging them |
| **A10** | Nothing is added to the ledger; `schema_version` is untouched | A bump makes live runs invisible to the installed supervisor (`.claude/agents/plugin-dev.md`) |
| **A11** | `prompts/dispatch.md` gets **static** prose only, no `{{token}}`, because its render site is the sibling's file | A token without the matching var in `deliver.ts:251-256` throws at delivery, in an agent's face |
| **A12** | The name is `pipeline-bootstrap`, flat under `.claude/`, not a `.claude/pipeline/` directory | There is exactly one such file; a directory is speculative |
| **A13** | *(new, MAJOR 1)* Detection reads `run.repo_root`'s **working tree**, which is assumed to be at or near the base the worktree is cut from (`--base main`, `prompts/dispatch.md:8`). `src/lib/repo.ts:17-25` yields a directory, with no ref in it. A primary checkout parked on an unrelated branch renders a stale line — in either direction | Handled, not prevented: the **C6** procedure is non-fatal on absence, so a false positive costs one skipped command rather than a halted batch. A false negative reverts to today's behaviour. **The same mismatch applies to the executable bit**, which `repoBootstrap` also reads from the working tree: `not-executable` can be reported about a file that is `755` on the base ref (its `chmod +x` remediation is then a no-op), and a `755` working-tree copy renders a clean `ready` line while the base ref's is `644` — the very case **C5** exists to prevent, defeated by this mismatch. Both directions now have error-table rows. Making any of it exact would need `git cat-file -e main:…`, which breaks C1's no-spawn/no-throw contract |
| **A14** | *(new, the ruling)* This task holds `src/cli.ts` and `test/cli-commands.test.ts` **by ruling, not by the gate** — the ledger records them on t1 (#26). Therefore: **#16 merges second**; rebase onto `main` after #26 lands and re-run `bun test` and `bun run typecheck` on the rebased result before opening the PR; edits confined to `cmdTask` `:255-269`; **a real rebase conflict is surfaced, not resolved** | If #26 lands changes inside `cmdTask` after all, the conflict is surfaced per the ruling's condition (3) rather than resolved here |

## Testing strategy

TDD, red first. Unit tests here use dependency-injected fakes and have passed clean over real
defects twice, so the live step below is not optional.

**New — `test/bootstrap.test.ts`** (one test file per lib module). Fixtures use `tempDir` from
`test/helpers/git-worktree.ts:12-16` plus `writeFileSync`/`chmodSync`; no git is needed, because
`repoBootstrap` is pure filesystem.

1. No `.claude/` → `{ kind: 'none' }`.
2. Mode-`755` script → `{ kind: 'ready' }`.
3. Mode-`644` script → `{ kind: 'not-executable' }` (**C5**).
4. A *directory* at that path → `{ kind: 'none' }` (**A7**, MINOR 3).
5. Nonexistent `repoRoot` → `{ kind: 'none' }`, and does not throw.
6. `bootstrapLine({kind:'none'})` → `bootstrap: none` exactly (**A2**).
7. `bootstrapLine` returns a **single line** — no `\n` — in all three states. This is the pin for
   MAJOR 2: a multi-line value would reopen the blank-line seam.
8. `bootstrapLine({kind:'not-executable'})` contains `chmod +x`.
9. `briefNote({kind:'none'})` → `''`; `briefNote({kind:'ready'})` contains `should have been run`
   and not `run for you` (MINOR 1).

**`test/cli-commands.test.ts`** (this task's per the ruling; edits appended, `cmdRewind` untouched)

**Modelled on `test/cli.test.ts:206-246`** — two tests that already assert exactly this contract:
"task echoes the file set it recorded while gated" (`:206-226`, asserting `task_id: t2`,
`files: src/lib/gating.ts, src/cli.ts` and `queued: waiting on t1`) is the fixture item 11 needs, and
"task echoes `files: none` on the dispatched return when nothing was declared" (`:228-246`, whose
comment reads "The brief still follows, after the header lines") is the fixture items 10, 12 and 13
need. `test/cli-argv.test.ts:52-98` proves the same contract through the real argv parser in a
subprocess, and its `fixture()` at `:20-35` already writes `<repo>/.claude/agents/core-dev.md`, one
`mkdirSync` from also writing `.claude/pipeline-bootstrap`.

**Why the new tests go to `test/cli-commands.test.ts` anyway, and not to the file they are modelled
on:** the ruling grants this task `src/cli.ts` and `test/cli-commands.test.ts`, and nothing else.
`test/cli.test.ts` and `test/cli-argv.test.ts` are in neither task's registered `--files`, so taking
them would collide with nothing — but it would also widen the grant without a ruling, which is the
habit this batch is trying to break. If the plan phase concludes the tests genuinely belong beside
their precedents, that is a decision to surface, not to take silently.

10. **Must fail before the change:** `cmdTask` on a run whose `repo_root` contains an executable
    `.claude/pipeline-bootstrap` returns output containing `bootstrap: .claude/pipeline-bootstrap`.
11. The same, for the **not-ready/queued** return at `src/cli.ts:260` — the line must appear there
    too, not only on the dispatched path.
12. **The blank-line contract (MAJOR 2):** in `cmdTask`'s dispatched output, every line before the
    first blank line is a header (`task_id:`, `files:`, `bootstrap:`), and the first line *after*
    the first blank line is the brief's `# <branch> — issue #<n>` heading. This is the assertion
    `prompts/dispatch.md:23-31` describes and the one MAJOR 2 asked for.
13. A repo with no declaration yields `bootstrap: none` and still satisfies test 12.

**`test/tasks.test.ts`**

14. **Must fail before the change:** a queued task in a run whose `repo_root` is a real temp dir with
    an executable script yields a dispatch prompt containing `bootstrap: .claude/pipeline-bootstrap`.
15. The same blank-line contract as test 12, for the supervisor message.
16. `mkRun` uses `repoRoot: '/r'` (`test/tasks.test.ts:26`), which does not exist, so every existing
    test takes the `none` branch. They must stay green **except** for any that assert the exact
    message shape — none do today, so a failure here is a real regression.

**`test/prompts.test.ts`**

17. **Must fail before the change:** `prompts/worker-brief.md` contains `{{bootstrap_note}}`.
18. A `renderWorkerPrompt`-shaped render of `worker-brief` leaves no `{{` behind, modelled on
    `test/prompts.test.ts:140-148`.
19. Unchanged and must stay green: the declared-set / no-orphan tests (`:16-24`) — no prompt file is
    added or removed — and `no prompt hardcodes the hpipe binary` (`:68-76`), so the new
    `dispatch.md` prose must not contain the literal `hpipe`.
20. `README.md` mentions `.claude/pipeline-bootstrap`, in the style of `:88-100`.
21. **The header-line convention cannot drift again (MAJOR 1):** `prompts/dispatch.md` names
    `bootstrap:` alongside `task_id:` and `files:`, and no longer says "two header lines". Modelled
    on `test/prompts.test.ts:60-66`, the existing `dispatch.md` content assertion.

**Whole suite:** `bun test` and `bun run typecheck` both green, **re-run after the rebase onto `main`
that follows #26** (**A14**), with the real numbers quoted in the PR body. CI is a PR-title lint only
(`.github/workflows/pr-title-lint.yml`), so nothing else runs them.

**Live verification (required, not a test).** The unit suite cannot prove an orchestrator reads and
acts on the line.

**Two preconditions gate every bullet below, and neither is optional.** (1) The plugin that serves
`hpipe task` and runs the supervisor is a GitHub install pinned to a commit — currently
`resolved_commit be181757…`, i.e. `main` before this branch existed (`herdr plugin list --json`) — so
**C1**, **C2** and **C3** are invisible to a live run until a release lands and
`herdr plugin install victorstein/herdr-plugin-pipeline` refreshes that pinned copy. The obvious
shortcut is forbidden by `.claude/agents/plugin-dev.md:46-49`: never link or run the checkout's
`src/cli.ts` against live state. (2) Detection reads `run.repo_root`'s working tree (**A13**) — the
primary checkout on `main` — so `.claude/pipeline-bootstrap` only exists there once #16 has merged.

The sequence is therefore: merge #16 (**second**, per **A14**) → release-please cuts a version →
reinstall the plugin → only then observe. **A `bootstrap: none` reading before that sequence
completes is uninformative, not a failure** — recording it as a pass is precisely the
pass-by-absence trap this checklist was rewritten to avoid.

On the next real batch in this repo after that sequence, whose `.claude/pipeline-bootstrap` **C6**
ships:

- **the `hpipe task` output carries `bootstrap: .claude/pipeline-bootstrap`** — this is the check
  pass 0 got wrong: it named only the supervisor message, which fires on 3 of 20 dispatches and
  would have been recorded as a pass by absence;
- `node_modules` in the new worktree has an mtime after `worktree.created` and before
  `pane.agent_detected` — the same three-clock check as `research:§2`, with no human in it;
- `hpipe brief --task <id>` renders the brief with the note and no `{{` left;
- a task registered while its gate is closed shows the line on the `queued:` output too;
- for a repo declaring nothing, every message shows `bootstrap: none` and nothing else changes.

A difference between this and what is observed is a finding, not a test to adjust.

## Rejected alternatives

- **Run it from the `worktree.created` hook.** herdr's own documented example plugin does exactly
  this (`example.worktree-bootstrap`, v0.9.1 socket-api doc `:536-554`). Rejected: hooks here must
  not block, herdr drops events past its concurrency cap, and the hook's cwd is the plugin root.
- **Run it from the supervisor at adoption** (`src/supervisor/tick.ts:165-175`). Rejected: adoption
  is measured ~23s *after* `pane.agent_detected`, so it races the worker it should precede, and a
  multi-minute `uv sync` inside a 1s tick loop stalls every other run.
- **Declare it in `config.env`** (`src/lib/config.ts:62-64`). Rejected: global to the plugin, one per
  user, so it cannot hold per-repo values — the exact property the issue asks for.
- **A `[[build]]` entry in `herdr-plugin.toml`.** Rejected per `research:§4`: install-only, no
  `plugin link`, no runtime context, wrong directory.
- **Static prose in `prompts/dispatch.md` only, with no detection** (the pass-0 reviewer's option 2).
  Rejected by the ruling: rendered once per run, hours before the last `hpipe task` call, which is
  the "knowledge lived in one agent's head for one session" failure the issue exists to remove. It
  would also make **C1**, **C2**, **C3** and **C5** dead code on 17 of 20 dispatches.
- **Fold the clause into `renderWorkerPrompt`'s return value** so all three call sites get it (the
  reviewer's option 3). Rejected: `prompts/dispatch.md:26-31` sends everything from the first blank
  line onward to the worker, so orchestrator-only text would land in the worker's prompt.
- **Multi-paragraph clause between the header and the brief** (pass 0's C2). Rejected per MAJOR 2:
  it moves the first blank line and breaks the documented split.
- **Reject registration when a repo declares no bootstrap.** Rejected: plenty of repos need nothing
  (**NG2**).
- **Resolve the ref exactly with `git cat-file -e main:.claude/pipeline-bootstrap`.** Rejected:
  breaks C1's no-spawn, no-throw contract and the error-handling row that depends on it. **A13**
  records the residual instead.

## Files this change declares

| File | New? | Component |
| --- | --- | --- |
| `src/lib/bootstrap.ts` | new | C1 |
| `test/bootstrap.test.ts` | new | C1 |
| `src/supervisor/tasks.ts` | — | C2 |
| `test/tasks.test.ts` | — | C2 |
| `src/cli.ts` (`cmdTask`, `:255-269` only) | — | C3 — **by ruling** |
| `test/cli-commands.test.ts` | — | C3 — **by ruling** |
| `src/lib/worker-prompt.ts` | — | C4 |
| `prompts/worker-brief.md` | — | C4 |
| `prompts/dispatch.md` | — | C6 (static prose only) |
| `test/prompts.test.ts` | — | C4, C6 |
| `.claude/pipeline-bootstrap` | new, mode 755 | C6 |
| `README.md` | — | C6 |

**The registered `--files` do not match this table, and cannot be made to** (MINOR 4). The live
ledger (`runs/pipeline/herdr-plugin-pipeline-20260919-…-wyy3.json`) records:

    t2 fix/16-worktree-bootstrap  ["prompts/dispatch.md","src/hooks","README.md",
                                   "src/lib/config.ts","test/config.test.ts"]
    t1 fix/26-verdict-overwrite   ["src/supervisor/deliver.ts","test/deliver.test.ts",
                                   "src/cli.ts","test/cli-commands.test.ts"]

Only `prompts/dispatch.md` and `README.md` overlap; `src/hooks`, `src/lib/config.ts` and
`test/config.test.ts` are held and unused. **The holdings this design relies on are the batch's
stated split plus the ruling, not the gate.** No command amends `task.files` — that is **#37**, on
its fourth consecutive occurrence — so re-registering is not available. Concretely, `filesOverlap`
will *not* hold this task off `src/cli.ts`, even though t1 declares it; the serialization is
**A14**'s merge-second condition, enforced by hand.
