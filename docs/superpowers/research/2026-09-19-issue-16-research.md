# Research — issue #16: fresh worktrees are not bootstrapped

Established against this worktree (`fix/16-worktree-bootstrap`, base `be18175`) on 2026-09-19.
Every claim below is either a `file:line` citation or a command and its output.

## 1. The break reproduces, here, in this repo

`git archive HEAD | tar -x` into a clean directory — a checkout with exactly the tracked files a
fresh worktree has — then:

    $ bun run typecheck
    $ tsc --noEmit
    /opt/homebrew/bin/bash: line 1: tsc: command not found
    error: script "typecheck" exited with code 127

`node_modules/` is gitignored (`.gitignore:1`, confirmed by `git check-ignore -v node_modules`), and
`tsc` comes from the `typescript` devDependency (`package.json:10-11`, `bun.lock`). So
`bun run typecheck` — which `.claude/agents/plugin-dev.md` makes a non-negotiable gate before every
push — fails on a fresh worktree until someone runs `bun install`. `bun test` needs nothing extra
(`bun:test` is built in), so the failure is typecheck-only *in this repo*; the issue's berean-os case
(no submodules, no `.venv`) breaks builds and `bin/clang-format-fix` outright.

## 2. The orchestrator is hand-bootstrapping, and the timestamps prove it

This very worktree was hand-bootstrapped during dispatch. Three independent clocks agree:

    $ stat -f '%Sm %N' -t '%Y-%m-%d %H:%M:%S' package.json node_modules
    2026-09-19 16:34:12 package.json      # git checked the tree out
    2026-09-19 16:34:26 node_modules      # someone ran `bun install`, 14s later

    $ herdr plugin log list --plugin stein.pipeline
    plugin-log-377  worktree.created      finished 1789857252078  → 16:34:12
    plugin-log-378  worktree.created      finished 1789857252124  → 16:34:12  (the sibling's)
    plugin-log-379  pane.agent_detected   finished 1789857275268  → 16:34:35

The gap is the whole mechanism: `worktree create` at 16:34:12, a manual `bun install` at 16:34:26,
`agent start` detected at 16:34:35. 23 seconds, inside one orchestrator turn, and the step in the
middle exists only because that orchestrator remembered it. That is precisely the knowledge the
issue says is lost at the end of a session.

## 3. Which files own the behaviour

**Nothing in this plugin creates a worktree.** `herdr worktree create` is run by the *orchestrator
agent*, instructed by `prompts/dispatch.md:7-9`:

    herdr worktree create --cwd {{repo_root}} --branch <branch> --base main
    # capture .result.root_pane.pane_id from that response
    herdr agent start <name> --kind claude --pane <root_pane_id> -- ...

The only other place `herdr worktree` is invoked from code is removal: `src/lib/herdr.ts:115-117`
(`worktreeRemove`), used by `src/supervisor/teardown.ts:24-35`. `grep -rn "worktree" src/` returns no
create path.

So the control flow at dispatch is:

1. `src/supervisor/tasks.ts:139-156` — a task whose gate opens enters `dispatch` and the supervisor
   pushes a prompt **to the orchestrator pane**: the literal line
   `` `worktree create --cwd ${run.repo_root}:` `` (`tasks.ts:151`) followed by
   `renderWorkerPrompt(...)`.
2. The orchestrator runs `worktree create`, then `agent start`, handing the rendered brief over as
   the agent's initial prompt. Both in one turn — the plugin is not in the loop between them.
3. `herdr` emits `worktree.created`. `src/hooks/worktree-created.ts` → `src/hooks/_hook.ts:76-81`
   only **enqueues** (`src/lib/queue.ts:20-28`); it never runs anything in the new checkout.
4. The supervisor drains and adopts: `src/supervisor/tick.ts:165-175` matches the event's `branch`
   against a task with `workspace_id === null` and records `checkout_path` from
   `raw.worktree.path` (`_hook.ts:55-56`).

Consequence for design: **adoption happens after the agent has already started**, so a bootstrap run
from the hook or from `applyEvents` would race the worker, not precede it. The window that is
actually before the worker is the orchestrator's dispatch turn (step 2) or the worker's own first
turn.

## 4. What herdr does and does not offer

- `herdr worktree create --help` (herdr 0.9.0 installed; docs index says stable is 0.9.1) lists
  `--workspace --cwd --branch --base --path --label --focus --no-focus --trust-repository`. **There
  is no post-create hook, setup command, or bootstrap option.**
- `[[build]]` in a plugin manifest is real but useless here, twice over. The herdr plugins doc
  (v0.9.1, "Build commands") says: *"Build commands run during GitHub `plugin install` … `plugin
  link` does not run build commands"*, and *"they do not receive runtime plugin context or Herdr
  socket env."* They also run in the **plugin's** directory, not a target repo's. `src/lib/render.ts:19-21`
  already records the first half of this. Our `herdr-plugin.toml` declares no `[[build]]` at all.
- Runtime plugin commands (events, actions, startup) *"run with the plugin directory as their
  working directory"* and receive `HERDR_PLUGIN_ROOT/CONFIG_DIR/STATE_DIR` — so a hook that wanted to
  bootstrap a worktree would have to `cd` there itself.
- The installed plugin is a GitHub install, not a link:
  `plugin_root=/Volumes/stein/.config/herdr/plugins/github/stein.pipeline-f39fb4f3495d`,
  `source.kind=github`, `resolved_commit=be181757…` (`herdr plugin list --json`). Matches the
  self-hosting hazard in `.claude/agents/plugin-dev.md`.

## 5. The nearest existing examples

**(a) A hardcoded, repo-specific bootstrap note already exists** — and it is the anti-pattern the
issue describes, frozen into the plugin. `src/lib/worker-prompt.ts:27-31`:

    dist_note: dependsOnCore
      ? '> `@repo/core` changed on `main` since this branch was cut. Run '
        '`pnpm install && pnpm turbo build --filter=@repo/core` before your first edit …'
      : '',

rendered into `prompts/worker-brief.md:14`. It names `pnpm`, `turbo` and `@repo/core` — none of
which exist in this repo or in berean-os — and it fires on `depends_on` a `core`-surface task, not
on anything the target repo declares. Introduced in `38ffabf` and last touched in `6d3b840`
(`git log -S dist_note`). Any general bootstrap mechanism should be measured against whether it
subsumes this.

**(b) Per-repo configuration read from the target repo already has one precedent**, and exactly one:
`src/cli.ts:188-191` resolves `<repo_root>/.claude/agents/<surface>-dev.md` and rejects registration
when it is absent —

    const agentFile = join(run.repo_root, '.claude', 'agents', `${input.surface}-dev.md`)
    if (!existsSync(agentFile)) {
      return fail(`no agent definition at ${agentFile} — check --surface`)
    }

documented to the orchestrator at `prompts/intake.md:27`. That is the repo telling the pipeline
something, validated at registration with a fail-fast message naming the absolute path. The closest
analogue of "configured in the repo rather than remembered by an orchestrator".

**(c) Plugin config is global, not per-repo.** `src/lib/config.ts:62-64` reads a single
`config.env` from `HERDR_PLUGIN_CONFIG_DIR` — `/Volumes/stein/.config/herdr/plugins/config/stein.pipeline`,
which is presently **empty** (`ls` shows no `config.env`). `REPOS_ALLOW` (`config.ts:16`) is a global
list, not per-repo settings. So `config.env` is the wrong home for a per-repo bootstrap command.

**(d) Test fixtures for real worktrees exist**: `test/helpers/git-worktree.ts:24-39`
(`repoWithWorktree`) builds a real repo plus a real `git worktree add`, deliberately — see its
docstring. Validation-style CLI failures are covered in `test/cli-commands.test.ts`; prompt/render
contracts in `test/prompts.test.ts` (which enforces the declared prompt set, `prompts.test.ts:10-24`,
and that a rendered prompt leaves no `{{placeholder}}`, `:140-148`).

## 6. Versions actually installed

    $ bun --version      1.3.14
    $ node --version     v24.16.0
    $ bunx tsc --version 5.9.3
    $ herdr --version    herdr 0.9.0      (docs stable channel: 0.9.1)
    $ git --version      2.54.0
    $ gh --version       2.96.0 (2026-07-02)

`node_modules/`: `@types` (`@types/bun@1.4.2`, `@types/node@26.5.1`), `bun-types@1.4.2`,
`typescript@5.9.3`, `undici-types@8.9.0` — the whole tree, per `bun.lock`. No runtime dependencies.

## 7. Baseline, this worktree, before any change

    $ bun test
     503 pass
     0 fail
     1265 expect() calls
    Ran 503 tests across 34 files. [11.13s]

    $ bun run typecheck    # tsc --noEmit, exit 0, no output

CI is a PR-title lint only (`.github/workflows/pr-title-lint.yml`) plus release-please
(`.github/workflows/release-please.yml`) — there is no test or typecheck job, so these numbers have
to be produced by hand and quoted.

## 8. Ownership constraints that bear on the design

Batch 4 pairs this task with #26, which holds `src/supervisor/deliver.ts`, `src/cli.ts` and their
tests. That matters because the two obvious seats for a bootstrap instruction are split across the
line:

| Seat | File | Whose |
|---|---|---|
| dispatch prompt to the orchestrator | `prompts/dispatch.md`, rendered at `src/supervisor/deliver.ts:259` with `common` (`deliver.ts:251-256`) | render site is **#26's** |
| the inline dispatch line | `src/supervisor/tasks.ts:151` | mine |
| the worker brief | `prompts/worker-brief.md`, rendered by `src/lib/worker-prompt.ts:16-36` | mine |
| registration-time validation | `src/cli.ts:188` (the `--surface` precedent) | **#26's** |

Adding a `{{...}}` token to `dispatch.md` requires touching `deliver.ts`; `render()` throws on an
unresolved placeholder at delivery time in front of an agent (`src/lib/render.ts:11`), so a
half-applied change there is a live-run failure, not a test failure.

## 9. Open questions this note does not settle

- Whether the bootstrap runs in the orchestrator's dispatch turn or as the worker's first act. Both
  windows exist (§3); the measured hand-fix used the first.
- Where in the target repo the command is declared, and whether it is a command string or an
  executable script path.
- Whether a missing/failing bootstrap should block dispatch or only warn. The `--surface` precedent
  (§5b) blocks at registration; nothing in the pipeline currently blocks at dispatch.
- Whether `dist_note` (§5a) is replaced by the new mechanism or left alone.
