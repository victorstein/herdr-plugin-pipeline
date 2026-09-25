# herdr-plugin-pipeline

Drives a software pipeline across herdr worktrees, with the design work pushed down to the agent that
has actually read the code.

One **worker** agent owns each GitHub issue end to end: research → spec → adversarial review → plan →
adversarial review → implement → two PR reviews → CI → merge → close → teardown. The **orchestrator**
keeps intake (research the problem, file the issue, dispatch), decision triage, merge, close, and the
whole-branch review at the end.

Workers surface **decisions, not drafts**. When one hits a choice it should not make alone, it calls
`hpipe decide` with a question *and a recommendation*; the orchestrator answers what it can from the
issue or the existing code, and escalates the rest to you with a recommendation already formed.

Event hooks only enqueue. One supervisor pane per herdr session owns all timing, evaluation, and
delivery, prompting each agent with its next instruction just in time — so the pipeline never has to
live in any agent's context, and fleet width scales with worker count rather than with one context
window.

## Install

From GitHub:

    herdr plugin install victorstein/herdr-plugin-pipeline

or, for local development:

    herdr plugin link /path/to/herdr-plugin-pipeline

Requires herdr 0.9.0+, bun, and gh. No build step, and no runtime dependencies —
`@types/bun` and `typescript` are devDependencies for `bun run typecheck` only.

**Claude Code skill.** `skills/herdr-pipeline/SKILL.md` teaches an agent to drive the pipeline:
the ground rules, running a batch, and recovery. Link it into your user skills so it loads in any
repo you orchestrate from:

    ln -sfn "$PWD/skills/herdr-pipeline" ~/.claude/skills/herdr-pipeline

**There is nothing else to install.** Agents never need `hpipe` on your PATH — every prompt renders
the CLI invocation in full, so the pipeline works the moment the plugin is installed.

The things you would reach for yourself are herdr **actions**, available from herdr's UI with no CLI
at all:

| Action | What it does |
|---|---|
| Pipeline status | the fleet, every open decision, anything waiting on you |
| Claim this pane as orchestrator | rebind a run whose orchestrator pane changed |
| Reopen the supervisor | when `status` says it died |
| Drain pending events | force a queue drain |

A CLI is only needed for the recovery commands, which take arguments actions cannot: `rewind`,
`release`, `abort`, `resume`, `forget`. Run those as `bun run <plugin-root>/src/cli.ts …`, or install
the shorthand with the **Install the hpipe shorthand** action — it links `bin/hpipe` into
`~/.local/bin` (override with `HPIPE_BIN_DIR`) and tells you if that is not on your PATH.

`forget` only unbinds a workspace; it does not keep the checkout. At teardown a merged task's checkout is
removed by its path even when its workspace is gone or forgotten. That happens only if three things hold:
- it is clean;
- it is still on the task's branch;
- its HEAD is pushed, to `origin/<branch>` or to the PR's head.

"Clean" ignores gitignored files, so `.env`, local config and `node_modules/` are deleted with the checkout.
Otherwise the checkout is kept and the task still ends `done`, with the reason in its history. Register a
task with `--keep-worktree` to keep its whole checkout, ignored files included.

**If you link it by hand, link `bin/hpipe`, never `src/cli.ts`.** The CLI and the supervisor share one
ledger — `cli.ts` falls back to `~/.local/state/herdr/plugins/stein.pipeline` when herdr has not
injected `HERDR_PLUGIN_STATE_DIR` — so a link pinned to a checkout means your hand-typed commands
write *that checkout's* schema into state the installed supervisor is driving. When the two drift,
which is the normal state of a repo you develop in, you get one of two failures: a phase the installed
table lacks makes `taskRow()` throw on the next tick, visible only in the supervisor pane; or a bumped
`schema_version` makes the run **silently invisible** to the supervisor, which just stops advancing it.
`bin/hpipe` asks herdr which copy is installed at call time, so one codebase writes the ledger — and
it follows the plugin if you ever switch between `plugin install` and `plugin link`, which move the
root.

**Then restart the herdr session you want it in.** Linking registers the plugin globally for your
user, but its startup hook only runs when a server boots — so on an already-running session nothing
happens until you restart it. If `hpipe status` reports no supervisor and no `pipeline` workspace
appeared, that is why. (`herdr server reload-config` does not trigger it either.)

**Run `hpipe` from inside a pane of the session you mean.** Outside one, it silently falls back to
the `default` session's ledger.

### Bootstrapping worker worktrees

Each task runs in a fresh `git` worktree, which has none of the build inputs your repo does not
track — `node_modules`, `.venv`, submodules, built `dist`. Declare how to restore them in an
executable `.claude/pipeline-bootstrap` at the repo root:

    #!/bin/sh
    set -e
    git submodule update --init
    uv sync

The orchestrator is told to run it in each new checkout before starting the worker, and the worker's
brief names it as the recovery if a build fails on a missing dependency. It runs from the worktree
root and **must be idempotent** — it can run more than once. A repo that needs nothing simply omits
the file; every dispatch then reports `bootstrap: none`.

It is also where a sibling package's build step belongs. If your apps consume another package's
built `dist` rather than its source, build it here (`pnpm install && pnpm turbo build
--filter=@repo/core`, say); the plugin itself never names a build command. The script builds
whatever the checkout contains, and a worktree is cut from the `origin/<default branch>` commit
fetched just before the task is dispatched — the `base:` line `hpipe task` and the supervisor's
`Dispatch tN` prompt both print — so a `--depends-on` task sees its merged dependencies whether or
not your local `main` has been pulled. A repo with no `origin` remote falls back to local `main`,
and a failed fetch says so on that line. The merge prompt asks the orchestrator to re-run the
bootstrap after it rebases a branch.

## Use

From the orchestrator's pane:

    hpipe start "chat meter"

The orchestrator is then prompted to research the work, open one GitHub issue per task — **the issue
body is the brief** — and register each with:

    hpipe task --branch <branch> --issue <n> --surface <surface> \
               [--depends-on <id,id>] [--files <prefix,prefix>] [--notes <batch context>] \
               [--run <run-id>]

Work that has no issue yet is filed and registered in one step: `--title <title> --body-file <path>`
in place of `--issue <n>` runs `gh issue create` in the run's repo, after every other check has
passed, and registers the task under the new number.

When a task is ready the orchestrator creates its worktree, starts a bare agent in the root pane, and
hands it the brief with:

    hpipe dispatch --task <id> --pane <pane-id> [--run <run-id>]

which submits the rendered brief over `herdr agent prompt` and exits non-zero unless herdr sees the
worker start on it. The brief cannot ride on `herdr agent start` itself: herdr refuses to pass an
argument containing its fences and backticks. When the batch is complete the orchestrator closes
intake with `hpipe dispatch --done`. Everything after that is injected: each worker gets its next
instruction as each phase completes.

`hpipe status` shows the fleet, every open decision, and anything waiting on you. For one task:

| | |
|---|---|
| `hpipe show --task <id> [--run <run-id>]` | What the run recorded: branch, issue, surface, files, dependencies, phase and its age, artifact and verdict paths, PR, CI, open decision |
| `hpipe brief --task <id> [--run <run-id>]` | The worker brief, rendered bare. Read-only — registering a task is the only other place it is printed |

Every subcommand takes `--help` (or `-h`), and does nothing else when given it.

## Answering a decision

    hpipe answer --task <id> --decision <id> --answer "…" --by orchestrator|human [--run <run-id>]

The answer is recorded immediately but the worker resumes **only once the answer has actually been
delivered** to its pane — a worker that is busy stays blocked, and `status` reports
"answered but undelivered" rather than pretending the decision was applied.

## Getting out

| | |
|---|---|
| Advanced early | `hpipe rewind <run> <phase> [--task <id>]` — clears retry counters and any undelivered answer. Rewinding a task to `implement` or earlier also forgets its recorded PR and CI state, which `implement` rediscovers from the branch's open PR. It refuses a phase that is in no row, and rewinding a task to a terminal phase also abandons any decision still open on it |
| Two live runs in one session | `task`, `brief`, `show`, `dispatch`, `release`, `decide` and `answer` resolve against the repo you are standing in and refuse a finished run. If one still cannot tell, it names the candidates — pass `--run <run-id>` |
| A task is escalated | `hpipe rewind <run> <phase> --task <id>` resumes it; `hpipe rewind <run> failed --task <id>` abandons it. The run stays in `execute`, and the task's dependents stay queued, until you do one |
| A task is stuck behind a failed sibling holding its files | `hpipe release --task <id>` |
| Stop driving a run | `hpipe abort <run>` (undo with `hpipe resume`) |
| Supervisor dead | `hpipe status`, then the `supervisor` action |
| Orchestrator pane died or changed id | Run the `claim` action from the pane that should drive it; `hpipe status` flags this |
| A pane stopped answering (agent exited, usage limit) | Nothing, to keep the run moving: workers still advance, and prompts owed to that pane are held in the run's outbox and sent once it answers again. `hpipe status` lists what is held. Restart the agent, or `claim` a new orchestrator pane |
| A run from an older plugin version | It is refused, not migrated. `hpipe abort <id>` to release the repo |
| Plugin misbehaving | `herdr plugin disable stein.pipeline` |
| Out permanently | `herdr plugin unlink stein.pipeline`, then `rm ~/.local/bin/hpipe` |

Nothing the plugin owns is load-bearing for the work: runs are bookkeeping, and the artifacts are
files in your repo and objects on GitHub.

## Design

`docs/superpowers/specs/2026-09-15-worker-owned-pipeline-design.md` is current, with two adversarial
reviews in `docs/superpowers/reviews/`. It amends
`specs/2026-09-13-herdr-pipeline-plugin-design.md`, whose supervisor, hooks, event transport, queue,
session scoping and predicate rules still hold — **read that document's "Verified herdr facts" table
before changing anything that touches the herdr or gh CLIs.** Every row was measured, and several
correct-looking assumptions in earlier drafts turned out to be wrong.

Two rules in the current design exist because breaking them shipped real bugs, twice each:

- **Retry counters are monotone.** Every row that can send a record back to a producer carries a
  counter keyed by itself, and nothing resets it on forward progress. Two earlier drafts reset on a
  forward transition and each time deleted a bound — once the review loop, once the CI retry budget.
- **A phase advances on an edge, not a level** — with two named exceptions. Predicates compare
  against `phase_entered_at`, or against the event that should have caused them. A level predicate
  re-fires forever and makes `hpipe rewind` a no-op on the row it was offered as the escape for.
  The exceptions are the run's `dispatch` (every dispatched task has a worktree) and a task's
  `merge` (its PR is merged): there the awaited state *is* the row's goal, a rewind into either
  sends no prompt and has nothing to re-trigger, and as edges both deadlocked on a state reached
  before the row was entered (#22).

`test/integration/smoke.md` is the live runbook, and its findings section records a full run: two
issues, two workers, two merged PRs, run `done`. That run found five bugs no unit test reached — the
worst being that herdr wraps every event as `{event, data:{…}}` while the hook read the outer object,
so **no task ever bound its pane** and the suite passed anyway, because the test fed the inner shape.

Two questions the unit suite cannot reach were measured there rather than asserted in `bun test`:
per-pane prompt fan-out, and whether a review subagent perturbs its worker pane's reported status. It
does not — a backgrounded subagent keeps the pane reading `working` for its whole duration, because
herdr's detection manifest has a dedicated rule for it. Re-run the runbook if you change either.

## License

MIT. See [LICENSE](./LICENSE).
