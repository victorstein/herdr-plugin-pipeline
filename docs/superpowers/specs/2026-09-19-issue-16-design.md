# Design — issue #16: fresh worktrees are not bootstrapped

Pass 0. No spec review exists for this issue yet
(`ls docs/superpowers/reviews/ | grep issue-16` → empty), so there is no *What changed* section.

Builds on `docs/superpowers/research/2026-09-19-issue-16-research.md`, cited below as
`research:§n`.

**Modelled on `docs/superpowers/specs/2026-09-18-issue-21-design.md`** — the most recent pass-0
design in this repo. Its section order (Problem / Goal / Non-goals / Architecture as numbered `C`
components / Data and control flow / Error handling / labelled-assumption table / Testing strategy /
Rejected alternatives), its "most droppable component" marking, and its explicit declared-files table
are reproduced deliberately. The text builders in **C1** are modelled on
`src/supervisor/stall.ts:255-289` (`awaitingFor`), which is this repo's established way to compose
an agent-facing sentence from a state value rather than templating it.

Baseline re-verified in this worktree at `76b0550`: `bun test` → **503 pass / 0 fail**, 1265
`expect()` calls across 34 files, 11.13s; `bun run typecheck` → clean, exit 0.

---

## Problem

`herdr worktree create` hands a worker a bare `git` checkout. Every input a repo does not track is
absent: `node_modules`, `.venv`, submodules, generated `dist`. The worker only discovers this when
its first build runs — which, in this pipeline, is at `implement`, hours after dispatch, for every
task in the batch at once.

It is real here, not just on berean-os. `git archive HEAD | tar -x` into a clean directory — exactly
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
(`research:§3`). And herdr offers nothing of its own: `herdr worktree create --help` has no
post-create hook, and `[[build]]` runs only on GitHub `plugin install`, never on `plugin link`, gets
no runtime context, and runs in the *plugin's* directory (herdr v0.9.1 plugins doc, "Build commands";
`src/lib/render.ts:19-21` already records half of this) (`research:§4`).

So the only actors that can bootstrap a checkout before the work starts are the two agents already
in the loop. The fix is to stop asking them to remember, and start telling them — from the repo.

## Goal

A repo declares, once and in its own tree, the command that makes a fresh checkout workable. The
pipeline reads that declaration and names it in the two places it matters, every single dispatch,
with no orchestrator memory involved:

1. In the per-task dispatch message the supervisor pushes to the orchestrator, alongside the
   `worktree create` line it already carries (`src/supervisor/tasks.ts:148-153`) — so it is run in
   the window the issue names, *after `worktree create` and before the worker starts*.
2. In the worker's own brief (`prompts/worker-brief.md`, rendered by
   `src/lib/worker-prompt.ts:10-36`) — so a worker whose checkout was *not* bootstrapped has a named
   one-command fix instead of an unexplained `command not found`.

Both read one source of truth. Declaring nothing keeps today's behaviour exactly.

This repo ships its own declaration as part of the change, so the next batch driven here is
bootstrapped by the mechanism rather than by hand.

## Non-goals

- **NG1 — the plugin does not execute the bootstrap.** Not from the `worktree.created` hook
  (`src/hooks/worktree-created.ts`): hooks "only enqueue; they must never block"
  (`.claude/agents/plugin-dev.md`), and a `uv sync` there would hold a herdr plugin-command slot for
  minutes. Not from the supervisor either: `TICK_MS` is 1000 (`src/lib/config.ts:24`) and adoption
  lands *after* `agent start` (`research:§3`), so it would race the worker it is meant to precede.
  See Rejected alternatives.
- **NG2 — no validation at registration.** The natural seat is beside the `--surface` check at
  `src/cli.ts:188-191`, and `src/cli.ts` belongs to the sibling task (#26) this batch. A repo that
  legitimately needs no bootstrap must also not be rejected. Follow-up, not this issue.
- **NG3 — `dist_note` is left alone.** `src/lib/worker-prompt.ts:27-31` hardcodes a
  `pnpm install && pnpm turbo build --filter=@repo/core` note and fires on `depends_on` a `core`
  surface, not on anything a repo declares. It is *task-conditional*, so a repo-level bootstrap
  cannot express it and does not subsume it. It is the same disease and deserves its own issue;
  removing it here would silently drop behaviour some repo depends on. Recorded as **A9**.
- **NG4 — no config file format, and no parser.** The README states the plugin has no runtime
  dependencies (`README.md:29-31`) and `bun.lock` confirms it. Introducing TOML/YAML parsing to hold
  one string would be inventing a pattern this repo does not have.
- **NG5 — no verification that the bootstrap ran, or succeeded.** Nothing generic can know what
  "bootstrapped" looks like across repos, and the plugin has no execution point (NG1). What the
  design buys is that the instruction is always delivered and always current; **A8** records what
  that does and does not guarantee.
- **NG6 — teardown is untouched.** `src/supervisor/teardown.ts` and `worktreeRemove` do not change.
- **NG7 — Windows.** `herdr-plugin.toml:6` declares `platforms = ["macos", "linux"]`.

## Architecture

Four components. **C4 is the most droppable** and is marked so.

### C1 (load-bearing) — `src/lib/bootstrap.ts`, a new pure lib module

One new module in `src/lib/`, the pure core, with one test file — the layout
`.claude/agents/plugin-dev.md` prescribes ("one file per lib module"). Modelled on
`src/lib/repo.ts` for size and single purpose, and on `src/supervisor/stall.ts:255-289` for shape:
a state value plus sibling functions that compose the agent-facing sentence, rather than a template.

    export const BOOTSTRAP_REL = '.claude/pipeline-bootstrap'

    export type Bootstrap =
      | { kind: 'none' }
      | { kind: 'ready' }
      | { kind: 'not-executable' }

    export function repoBootstrap(repoRoot: string): Bootstrap
    export function dispatchClause(b: Bootstrap): string   // for the orchestrator
    export function briefNote(b: Bootstrap): string        // for the worker

`repoBootstrap` is `existsSync` plus a mode-bit test on `join(repoRoot, BOOTSTRAP_REL)` and nothing
else. It never reads the file, never spawns anything, and never throws — a `statSync` failure
degrades to `{ kind: 'none' }`.

**The path argument is always `run.repo_root`, an absolute path from the ledger
(`src/lib/ledger.ts:29`), never `process.cwd()`.** This is load-bearing: herdr runs plugin commands
"with the plugin directory as their working directory" (v0.9.1 plugins doc, "Commands and
environment"), so the supervisor's cwd is the *plugin* root, and `cmdBrief`'s cwd is wherever a human
typed it. `run.repo_root` is the only value all three processes agree on — the same reason
`src/supervisor/tasks.ts:103` and `src/supervisor/deliver.ts:113` already key off it.

### C2 — the orchestrator is told, in the message that creates the worktree

`src/supervisor/tasks.ts:148-153` composes the per-task dispatch prompt today:

    text: `Dispatch ${task.task_id} (${task.branch}, #${task.issue}) — ` +
      `worktree create --cwd ${run.repo_root}:\n\n` +
      (await renderWorkerPrompt(deps.pluginRoot, run, task)),

`dispatchClause(repoBootstrap(run.repo_root))` is inserted between the header line and the brief.
When the repo declares nothing it is the empty string and the message is byte-identical to today's.
When it declares one, the orchestrator reads (`ready` case):

    This repo declares a worktree bootstrap. Run it in the NEW checkout after `worktree create`
    and before `agent start`; the create response carries the path as `.result.worktree.path`:

        (cd "<.result.worktree.path>" && ./.claude/pipeline-bootstrap)

    A fresh checkout has none of the repo's ignored build inputs, so skipping this hands the
    worker a broken build it will not hit until `implement`. Wait for it to exit 0. If it fails,
    say so instead of starting the worker on a broken checkout.

`.result.worktree.path` is real: `worktree.create` "returns the new `workspace`, `tab`, `root_pane`,
and `worktree` records" (herdr v0.9.1 socket-api doc `:392`), and a worktree record carries `path` —
confirmed live, `herdr worktree list --cwd <repo>` returns
`{"branch":"fix/16-worktree-bootstrap", …, "path":"/Volumes/stein/.herdr/worktrees/…"}`. The same
field is what `src/hooks/_hook.ts:56` already reads off the `worktree.created` event.

**This is the per-task message, not `prompts/dispatch.md`.** `dispatch.md` is rendered once per run
when the run enters `dispatch` (`src/supervisor/deliver.ts:259`), whereas this fires per task at the
moment that task's gate opens — which is the moment its worktree is created. It is also the only one
of the two inside this task's holdings (`research:§8`).

### C3 — the worker is told, as its recovery path

`src/lib/worker-prompt.ts:16-32` gains one var,

    bootstrap_note: briefNote(repoBootstrap(run.repo_root)),

and `prompts/worker-brief.md` gains `{{bootstrap_note}}` immediately after `{{dist_note}}`
(`worker-brief.md:14`), which is the existing slot for exactly this kind of conditional
environment note. `briefNote` returns `''` when nothing is declared — the same empty-string
convention `dist_note` already uses (`worker-prompt.ts:31`), which renders as a blank line.

The `ready` text:

    > This worktree is bootstrapped by `./.claude/pipeline-bootstrap`, run for you before you
    > started. If a build, test or typecheck fails on a missing dependency, run it yourself rather
    > than installing anything by hand.

One var added inside `renderWorkerPrompt` covers **all three** of its call sites for free —
`src/supervisor/tasks.ts:152`, `src/cli.ts:268` and `cmdBrief` at `src/cli.ts:286` — so **no edit to
`src/cli.ts` is needed** and the sibling's file is untouched.

`vars` is passed to both `worker-brief` and `research` renders (`worker-prompt.ts:34-35`). Extra vars
are ignored by `render()`; only a *missing* one throws (`src/lib/render.ts:11`). Adding a key is
therefore safe for both.

### C4 (most droppable) — the `not-executable` state

`git` records the executable bit, but only if it is set when the file is first added, and a repo
author adding `.claude/pipeline-bootstrap` without `chmod +x` is a routine mistake. Without this
branch the orchestrator gets a bare `permission denied` mid-dispatch. With it, both renderers say:

    `.claude/pipeline-bootstrap` exists in this repo but is not executable. Fix it on `main` with
    `chmod +x .claude/pipeline-bootstrap`; until then this checkout cannot be bootstrapped.

Cost: one `statSync` mode test and two strings. Drop it and `repoBootstrap` collapses to two states
and one `existsSync`, mirroring `src/cli.ts:188-191` exactly. Nothing else in the design depends on
it.

### C5 — this repo declares its own, and the README documents the contract

- `.claude/pipeline-bootstrap`, mode `755`:

      #!/bin/sh
      # A fresh worktree has no node_modules and `bun run typecheck` needs tsc from it.
      set -e
      bun install

  This is the dogfood: `research:§1` proves this repo needs it, and shipping it means the mechanism
  is exercised by the next batch driven here rather than only by tests.
- `README.md` gains a short subsection under **Install** stating the contract: the path, that it must
  be executable, that it is run from the worktree root, that it must be idempotent (**A6**), and that
  a repo needing nothing simply omits it. README content is already test-covered
  (`test/prompts.test.ts:88-100`).
- `prompts/dispatch.md` gains two static sentences pointing at the per-task message. **No new
  `{{token}}`** — its render site is `src/supervisor/deliver.ts:259`, the sibling's file, and a token
  with no matching var throws at delivery in front of an agent (`src/lib/render.ts:11`).

## Data and control flow

Unchanged parts are marked (=).

    (=) gate opens for a queued task          src/supervisor/tasks.ts:139-147
         │
         ├─ NEW: repoBootstrap(run.repo_root)  → {none | ready | not-executable}
         │       (pure fs; no spawn, no throw)
         │
    (=) supervisor pushes one prompt to run.orchestrator_pane   tasks.ts:148-153
         │   header line + NEW dispatchClause(...) + renderWorkerPrompt(...)
         │                                             │
         │                                             └─ NEW: briefNote(...) → {{bootstrap_note}}
         │                                                     prompts/worker-brief.md:15
         ▼
    (=) orchestrator: herdr worktree create --cwd <repo_root> --branch <b> --base main
         │            → .result.worktree.path, .result.root_pane.pane_id
         │
         ├─ NEW: (cd "<path>" && ./.claude/pipeline-bootstrap)   ← the window the issue names
         │
    (=) orchestrator: herdr agent start … --pane <root_pane_id> -- "<brief>"
         ▼
    (=) worker's first turn: research. The brief names the bootstrap as its recovery.

    (=) in parallel: worktree.created → hook enqueues → tick.ts:165-175 adopts, ~23s later.
        Nothing in this path is touched.

The declaration is read at **prompt-render time**, once per dispatch, from `main`'s checkout. A repo
that adds or changes its bootstrap picks it up on the next task dispatched; nothing is cached, and
no ledger field is added — **`schema_version` does not change**, so runs already on disk are
unaffected (the hazard `.claude/agents/plugin-dev.md` calls out).

## Error handling

| Condition | Behaviour | Why |
| --- | --- | --- |
| No `.claude/pipeline-bootstrap` | Both renderers return `''`; messages byte-identical to today | A repo needing nothing is the common case and must not be nagged (**A2**) |
| Declared and executable | Both clauses render | The intended path |
| Declared, not executable | Both render the `chmod +x` text instead (**C4**) | Turns `permission denied` into a named fix |
| `repoRoot` does not exist, or `statSync` throws (EACCES, ELOOP, dangling symlink) | Caught; `{ kind: 'none' }` | `renderWorkerPrompt` must never throw: it is on the dispatch path and on `hpipe brief`. `src/lib/herdr.ts:33-41` sets the precedent — degrade, never crash the supervisor loop |
| Bootstrap script exits non-zero | The orchestrator reports it and does not start the worker | Instructed in **C2**; the plugin cannot observe it (**NG5**, **A8**) |
| Orchestrator skips the clause entirely | Worker hits it at `implement`; the brief names the fix (**C3**) | Accepted residual risk — **A8** |
| A directory at that path | `existsSync` true, `statSync().mode & 0o111` true for a dir → would render `ready` | **A7**: also require `isFile()` |

## Assumptions

Each is a behavioural choice, stated so it can be attacked.

| # | Assumption | If wrong |
| --- | --- | --- |
| **A1** | The declaration is an **executable script at `<repo_root>/.claude/pipeline-bootstrap`**, not a command string in a config file. Mirrors the one existing per-repo-config precedent, `src/cli.ts:188-191`'s `<repo_root>/.claude/agents/<surface>-dev.md` — a conventional path under `.claude/`, existence-checked. Needs no parser (**NG4**), handles multi-step bootstraps (submodules *and* `uv sync` *and* a build), is reviewable in PRs, and a human can run it directly | A config key would need a format and a parser, or a one-line command would not cover berean-os's case |
| **A2** | **Absence is silent**, in both renderers. No "this repo declares no bootstrap" line | If a repo *should* have one, nothing says so. NG2's follow-up (registration-time validation) is where that belongs |
| **A3** | **The orchestrator runs it, between `worktree create` and `agent start`.** Taken directly from the issue's Directions — *"run after `worktree create` and before the worker starts"* — and it is the window the hand-fix actually used (`research:§2`) | The alternative is the worker's first turn; that leaves the worktree broken for anything the orchestrator does in between, and contradicts the issue |
| **A4** | **The worker is told too**, as recovery, not as a second execution. It does not re-run the bootstrap unconditionally | Belt-and-braces re-running would be safe (**A6**) but doubles `npm ci`-class cost on every task |
| **A5** | **Two renderers, one reader.** `dispatchClause` and `briefNote` are separate functions over one `Bootstrap` value, following `awaitingFor`'s `{short, clause}` pair at `src/supervisor/stall.ts:274-283` | One shared string would be wrong for one of the two audiences |
| **A6** | **The script must be idempotent**, stated in the README contract. `bun install`, `npm ci`, `uv sync`, `git submodule update --init` all are | If a repo's is not, a worker following **A4**'s recovery could damage its checkout |
| **A7** | `repoBootstrap` requires a **regular file** (`statSync().isFile()`), not just existence, before checking the mode bit | A directory named `pipeline-bootstrap` would otherwise render as `ready` |
| **A8** | The mechanism **instructs; it does not enforce.** An orchestrator that ignores the clause still produces a broken worktree. The durability win is that the knowledge is in the repo and re-rendered every dispatch, not that execution is guaranteed. There is no non-agent executor available in that window (**NG1**) | If enforcement is required, the whole design is wrong and the answer is a herdr feature request, not a plugin change |
| **A9** | `dist_note` stays (**NG3**) and the two notes can both render, producing two blockquotes | If they read badly stacked, the fix is ordering in `worker-brief.md`, not merging them |
| **A10** | Nothing is added to the ledger; `schema_version` is untouched | A bump would make live runs invisible to the installed supervisor (`.claude/agents/plugin-dev.md`, "the self-hosting hazard") |
| **A11** | `prompts/dispatch.md` gets **static** prose only, no `{{token}}`, because its render site is the sibling's file | A token added without the matching var in `deliver.ts:251-256` throws at delivery, in an agent's face (`src/lib/render.ts:11`) |
| **A12** | The name is `pipeline-bootstrap`, flat under `.claude/`, not a `.claude/pipeline/` directory | There is exactly one such file; a directory is speculative |

## Testing strategy

TDD, red first, per `.claude/agents/plugin-dev.md` and the brief. Unit tests here use
dependency-injected fakes and have passed clean over real defects twice, so the live-run step below
is not optional.

**New — `test/bootstrap.test.ts`** (one test file per lib module). Fixtures use `tempDir` from
`test/helpers/git-worktree.ts:12-16` plus `writeFileSync`/`chmodSync`; no git is needed, because
`repoBootstrap` is pure filesystem.

1. `repoBootstrap` on a root with no `.claude/` → `{ kind: 'none' }`.
2. …with a mode-`755` `.claude/pipeline-bootstrap` → `{ kind: 'ready' }`.
3. …with a mode-`644` one → `{ kind: 'not-executable' }` (**C4**).
4. …with a *directory* at that path → `{ kind: 'none' }` (**A7**).
5. …on a nonexistent `repoRoot` → `{ kind: 'none' }`, and does not throw.
6. `dispatchClause({kind:'none'})` and `briefNote({kind:'none'})` → `''` exactly (**A2**).
7. `dispatchClause({kind:'ready'})` contains `.result.worktree.path` and `BOOTSTRAP_REL`.
8. `briefNote({kind:'not-executable'})` contains `chmod +x`.

**`test/tasks.test.ts`** (mine; `src/supervisor/tasks.ts` is this task's). `mkRun` uses
`repoRoot: '/r'` (`tasks.test.ts:26`), which does not exist — so every existing test takes the
`none` branch and **must stay green unchanged**; that is itself the regression assertion for **A2**.

9. **Must fail before the change:** a queued task in a run whose `repo_root` is a real temp dir
   containing an executable `.claude/pipeline-bootstrap` yields a dispatch prompt containing
   `pipeline-bootstrap`. Today's message cannot contain it.
10. The same run with no declaration yields a prompt containing neither `pipeline-bootstrap` nor
    `bootstrap` — pinning byte-compatibility for repos that declare nothing.

**`test/prompts.test.ts`**

11. **Must fail before the change:** `prompts/worker-brief.md` contains `{{bootstrap_note}}`.
12. `renderWorkerPrompt`-shaped render of `worker-brief` leaves no `{{` behind, modelled on
    `test/prompts.test.ts:140-148` ("a rendered probe leaves no placeholder behind") — the guard
    against the `render()`-throws-at-delivery failure mode.
13. The declared-prompt-set and no-orphan tests (`prompts.test.ts:16-24`) are unchanged: no prompt
    file is added or removed.
14. The `no prompt hardcodes the hpipe binary` test (`prompts.test.ts:68-76`) must still pass — the
    new prose must not contain the literal string `hpipe`.
15. `README.md` mentions `.claude/pipeline-bootstrap`, in the style of `prompts.test.ts:88-100`.

**Whole suite:** `bun test` and `bun run typecheck` both green, quoted with real numbers in the PR
body. CI is a PR-title lint only (`.github/workflows/pr-title-lint.yml`), so nothing else runs them.

**Live verification (required, not a test).** The unit suite cannot prove the orchestrator reads and
acts on the clause. After merge, on the next real batch in this repo — whose
`.claude/pipeline-bootstrap` **C5** ships:

- the per-task dispatch message in the orchestrator pane contains the clause;
- `node_modules` in the new worktree has an mtime *after* `worktree.created` and *before*
  `pane.agent_detected`, the same three-clock check as `research:§2`, but with no human in it;
- `hpipe brief --task <id>` renders the brief with the note and no `{{` left;
- a worktree for a repo with no declaration produces the byte-identical message it does today.

A difference between this and what is observed is a finding, not a test to adjust.

## Rejected alternatives

- **Run it from the `worktree.created` hook.** herdr's own documented example plugin does exactly
  this — `example.worktree-bootstrap`, `[[events]] on = "worktree.created"` (v0.9.1 socket-api doc
  `:536-554`). Rejected: hooks in this plugin must not block
  (`.claude/agents/plugin-dev.md`; `src/hooks/_hook.ts:76-81` only enqueues), herdr drops events
  past its concurrency cap, and the hook's cwd is the *plugin* root, not the worktree. It also
  cannot be per-repo without re-deriving the repo from the event.
- **Run it from the supervisor at adoption** (`src/supervisor/tick.ts:165-175`). Rejected: adoption
  is measured ~23s *after* `pane.agent_detected` (`research:§2`), so it races the worker it should
  precede, and a multi-minute `uv sync` inside a 1s tick loop (`src/lib/config.ts:24`) stalls every
  other run.
- **Declare it in `config.env`** (`src/lib/config.ts:62-64`). Rejected: that file is global to the
  plugin, one per user (`/Volumes/stein/.config/herdr/plugins/config/stein.pipeline`, currently
  empty), so it cannot hold per-repo values — the exact property the issue asks for.
- **A `[[build]]` entry in `herdr-plugin.toml`.** Rejected on the evidence in `research:§4`: install-
  only, no `plugin link`, no runtime context, wrong directory.
- **Put the clause in `prompts/dispatch.md` with a `{{bootstrap}}` token.** Rejected: the render site
  is `src/supervisor/deliver.ts:259`, held by #26 this batch, and `dispatch.md` is delivered once per
  run rather than once per worktree (**A11**, **C2**).
- **Reject registration when a repo declares no bootstrap**, beside `src/cli.ts:188-191`. Rejected:
  `src/cli.ts` is the sibling's, and plenty of repos need nothing (**NG2**).

## Files this change declares

| File | New? | Component |
| --- | --- | --- |
| `src/lib/bootstrap.ts` | new | C1 |
| `test/bootstrap.test.ts` | new | C1 |
| `src/supervisor/tasks.ts` | — | C2 |
| `test/tasks.test.ts` | — | C2 |
| `src/lib/worker-prompt.ts` | — | C3 |
| `prompts/worker-brief.md` | — | C3 |
| `prompts/dispatch.md` | — | C5 (static prose only) |
| `test/prompts.test.ts` | — | C3, C5 |
| `.claude/pipeline-bootstrap` | new, mode 755 | C5 |
| `README.md` | — | C5 |

`src/cli.ts`, `src/supervisor/deliver.ts`, `test/cli*.test.ts` and `test/deliver.test.ts` are **not**
touched — they belong to #26 this batch (`research:§8`). `test/prompts.test.ts` is a shared guard
file owned by neither task; the additions there are append-only.
