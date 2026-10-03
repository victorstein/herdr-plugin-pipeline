# herdr-plugin-pipeline

Drives a software pipeline across herdr worktrees, with the design work pushed down to the agent that
has actually read the code.

One **worker** agent owns each bead end to end: research → spec → adversarial review → plan →
adversarial review → implement → PR review → CI → merge → close → teardown, with the reviews a task
runs set by its **tier** (below). The **orchestrator** keeps intake (pick or file the bead, dispatch),
decision triage, merge, and the whole-branch review at the end; the supervisor closes the bead once
the merge is recorded. The backlog lives in [Beads](https://github.com/gastownhall/beads), one
database per repo (see **Beads** below); GitHub keeps the PRs, CI and merges.

Workers surface **decisions, not drafts**. When one hits a choice it should not make alone, it calls
`hpipe decide` with a question *and a recommendation*; the orchestrator answers what it can from the
brief or the existing code, and escalates the rest to you with a recommendation already formed.

Event hooks only enqueue. One supervisor pane per herdr session owns all timing, evaluation, and
delivery, prompting each agent with its next instruction just in time — so the pipeline never has to
live in any agent's context, and fleet width scales with worker count rather than with one context
window.

## Install

From GitHub:

    herdr plugin install victorstein/herdr-plugin-pipeline

or, for local development:

    herdr plugin link /path/to/herdr-plugin-pipeline

Requires herdr 0.9.0+, bun, gh, and `bd` 1.3.1+ (`brew install beads`); `bv` 0.25.2+ for the board
and `hpipe next` (see **Beads** below). No build step, and no runtime dependencies — `@types/bun` and
`typescript` are devDependencies for `bun run typecheck` only.

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
| Set up Beads for this repo | create the repo's Beads store with the default prefix (run from a pane in the repo) |
| Open board | reopen the repo's `bv` board tab (run from a pane in the repo) |

A CLI is only needed for the commands that take arguments actions cannot: the recovery commands
`rewind`, `release`, `abort`, `resume`, `forget` and `close`, and the read-only `bead show` and
`next`. Run those as `bun run <plugin-root>/src/cli.ts …`, or install
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

The first `hpipe start` in a repo sets up its Beads store. The orchestrator is then prompted to
research the work, run `hpipe next` over the repo's backlog, and back each task with one bead —
**the bead's brief, captured when the task is registered, is the worker's brief** — registering each
with:

    hpipe task --branch <branch> --bead <id> --surface <surface> \
               [--tier light|standard|heavy] \
               [--depends-on <id,id>] [--files <prefix,prefix>] [--notes <batch context>] \
               [--run <run-id>]

Work the backlog does not hold yet is filed and registered in one step: `--title <title>
--body-file <path> [--acceptance-file <path>]` in place of `--bead <id>` creates the bead after every
other check has passed, and registers the task under its id. Adopting with `--bead` refuses a bead
that is closed, assigned, held by a live task in any session, blocked by an open bead, or the parent
of open child beads — each would trip one of bd's close guards at merge.

When a task is ready the orchestrator creates its worktree, starts a bare agent in the root pane, and
hands it the brief with:

    hpipe dispatch --task <id> --pane <pane-id> [--run <run-id>]

which submits the rendered brief over `herdr agent prompt` and exits non-zero unless herdr sees the
worker start on it. The brief cannot ride on `herdr agent start` itself: herdr refuses to pass an
argument containing its fences and backticks. When the batch is complete the orchestrator closes
intake with `hpipe dispatch --done`. `dispatch --task` claims the task's bead first; if bd refuses the
claim, nothing is sent. Everything after that is injected: each worker gets its next
instruction as each phase completes.

`hpipe status` shows the fleet, every open decision, and anything waiting on you. For one task:

| | |
|---|---|
| `hpipe show --task <id> [--run <run-id>]` | What the run recorded: branch, bead, surface, files, dependencies, phase and its age, artifact and verdict paths, PR, CI, open decision |
| `hpipe brief --task <id> [--run <run-id>]` | The worker brief, rendered bare. Read-only — registering a task is the only other place it is printed |
| `hpipe bead show <id>` | A bead as Beads holds it now: status, labels, description, acceptance, comments |
| `hpipe next [--limit <n>] [--label <label>]` | The unheld beads `bv` ranks claimable now (parallel only when their `--files` are disjoint), then one line per later dependency layer, each waiting on the one before; then blockers to clear and alerts. `--label` filters bv's top 10 recommendations, not every bead |

Workers record out-of-scope bugs and follow-ups with `hpipe discover` instead of fixing them in their
PR. At the branch review the orchestrator lists them with `hpipe discoveries` and files them with
`hpipe discoveries --file`: one bead each, labelled `discovered` and `discovery:<run>:<task>:<id>`,
linked to the bead it came from. Filing goes in order and stops at the first failure, keeping what
it already filed; a retry carries on from there and files nothing twice.

When a decision needs you, the orchestrator runs `hpipe escalate --task <id> --decision <id>
--recommend "<its recommendation>"`: the task's bead turns `blocked`, gains `hpipe:awaiting-human`,
and carries the question as a comment until you answer.

Every subcommand takes `--help` (or `-h`), and does nothing else when given it.

## Review tiers

Every task carries a tier that decides which reviews it runs:

| Tier | `spec-review` | `plan-review` | PR review |
|---|---|---|---|
| `light` | ✓ | – | one combined `pr-review` |
| `standard` | ✓ | ✓ | one combined `pr-review` |
| `heavy` | ✓ | ✓ | `pr-review-intent`, then `pr-review-quality` |

The orchestrator sets it at registration with `--tier light|standard|heavy`; a new task defaults to
`standard`. A bead labelled `pipeline:tier-light`, `pipeline:tier-standard` or `pipeline:tier-heavy`
overrides `--tier`, and a bead carrying two tier labels is refused. Labels are read once, at
registration, and `hpipe task` prints the result as `tier: <tier> (<why>)`.

Mid-run, `hpipe tier --task <id> <tier> --why "<reason>"` changes it. Raising works from any pane;
lowering is refused from the orchestrator's and the workers' panes, so run it from your own. The
phase the task is in always completes; only the next step follows the new tier, and a raise never goes
back for a review already skipped (`hpipe rewind` does). `hpipe show --task <id>` prints the tier, its
log, and every phase the task visited.

A run in which at most one task landed skips the final `branch-review` and finishes. Either way,
the orchestrator is sent a short notice when its run reaches `done`, saying where each task ended.

## Beads

Each repo's backlog is its own [Beads](https://github.com/gastownhall/beads) database, kept in the
plugin's state dir at `$HERDR_PLUGIN_STATE_DIR/beads/<repo>-<hash>/` — never in your repo, and out of
reach of every worker worktree. hpipe is its only writer: every write runs as actor `hpipe`, one call
at a time under a lock, and the supervisor converges each bead to what the run's ledger says — claimed
while its task is worked, blocked while a decision waits on you, released if the task is abandoned or
the run aborted, closed once its PR merges. The close is the supervisor's; nobody is prompted for it.

**Install** `bd` 1.3.1 or newer — Homebrew core's `beads` formula (`brew install beads`); older
releases lack the close guards this relies on — and, for the board and `hpipe next`, `bv` 0.25.2 or
newer (`brew install dicklesworthstone/tap/bv` — read its licence first, below). `BD_BIN` / `BV_BIN`
point at other binaries. `hpipe start` refuses without a working `bd`; without `bv` the pipeline runs
and only the board and `hpipe next` are off. `hpipe status` prints a `tools:` line when either is
missing or too old.

**Setup** happens on the first `hpipe start` in a repo, or on demand with the **Set up Beads for this
repo** action from a pane in it. Bead ids are `<prefix>-<n>`; the prefix defaults to the repo's name
cut to eight characters. To choose another, pass `hpipe start --prefix <p>` on the first start: once
the store exists the prefix is fixed and `--prefix` is ignored. The action uses the default prefix,
or `HPIPE_BEADS_PREFIX` if it is set in herdr's own environment. A prefix holds letters, digits and
dashes and must start with a letter; it is stored lowercase, with any trailing dashes trimmed. Setup
refuses a prefix another repo's store already uses, and one whose `<prefix>-<n>` names
already appear under `docs/superpowers/`.

**Back up `$HERDR_PLUGIN_STATE_DIR/beads`.** It is the only copy of every backlog, and it cannot be
rebuilt from the repo: set up again, a store restarts its counter at `<prefix>-1`.

**Do not run `bd` yourself while a run is live.** The store takes one writer at a time and a second
fails fast; read a bead with `hpipe bead show <id>` instead. **Never run `bd reclaim` on an hpipe
store**: every claim carries a 5-minute lease that hpipe never renews and nothing else acts on, so
`bd reclaim` would revert each bead claimed more than five minutes ago to `open` behind hpipe's back.
The supervisor re-claims them on its next pass, but until then they look free.

**The board.** Each repo with a live run in the session gets one `Board: <repo> <hash>` tab in the
pipeline workspace, running `bv` on the export hpipe writes after every change; press `b` for the
kanban. The supervisor closes it once the repo has no live run, and a stale `Board: …` tab left by a
herdr restart is closed and replaced. The **Open board** action reopens it. It is read-only by
construction. **Never install `br` alongside `bv`**: bv's edit path shells out to `br`, which would
write to the store behind hpipe's back; with no `br` installed that path fails harmlessly.

**bv's licence.** bv is MIT-licensed with a rider. Its
[LICENSE](https://github.com/Dicklesworthstone/beads_viewer/blob/main/LICENSE) says, among other
things:

> "Restricted Parties" means OpenAI, L.L.C.; Anthropic, PBC; any of their respective Affiliates; and
> any person or entity acting directly or indirectly on behalf of, for the benefit of, or under the
> direction of any of the foregoing (including any officer, director, employee, contractor, agent,
> consultant, service provider, or representative).
>
> Notwithstanding any other provision of this License, no rights are granted to any Restricted Party.
> Any purported license, sublicense, assignment, transfer, or other permission to any Restricted Party
> is null and void absent the express prior written permission of Jeffrey Emanuel.
>
> You may not provide, disclose, distribute, sublicense, sell, lease, lend, host, make available, or
> otherwise permit access to the Software or any derivative work of the Software (as defined in
> applicable copyright law) (collectively, "Derivative Works") to or for any Restricted Party.
>
> For purposes of this rider, "use" includes, without limitation: copying, modifying, merging,
> publishing, distributing, sublicensing, selling, transferring, making available, hosting,
> deploying, executing, benchmarking, testing, analyzing, indexing, or incorporating the Software or
> any Derivative Works into any dataset, training corpus, evaluation harness, or pipeline for machine
> learning or other automated systems.

Read the whole licence and judge for yourself whether the rider applies to you — `hpipe next` runs
`bv` on an agent's behalf — before you install it. This plugin vendors and forks none of bv's code; it
only runs the binary you install, and everything but the board and `hpipe next` works without it.

## Models

Judgment stays on Opus: the orchestrator, every worker session and every reviewer subagent inherit
your default model, and only `implement`'s code-writing is handed to a subagent pinned to Sonnet.
Run Claude with Opus as the default model. Nothing pins the worker panes, so a Sonnet default would
put the judgment on Sonnet too.

## Upgrading

Restart the supervisor after upgrading the plugin, in every session with a run in flight: close its
`Pipeline supervisor` pane and run the plugin's `supervisor` action, or restart the session. A
supervisor still running the old code beside a new CLI routes a task by the old phase table while the
CLI briefs it on the new one. The review-tiers release also changes the on-disk format: a ledger
holding a task in `pr-review` cannot be read by an earlier version, so finish or abort those runs
before rolling back. Tasks registered before tiers existed carry none and run as `heavy` — every
review, as before.

The Beads release moves the ledger to `schema_version: 3`. Runs started before it are not migrated
and are no longer advanced: finish them on the previous release, then upgrade and restart the
supervisor. They do not block `hpipe start`, and the commands that address a task or its
discoveries do not see them.

## Answering a decision

    hpipe answer --task <id> --decision <id> --answer "…" --by orchestrator|human [--run <run-id>]

The answer is recorded immediately but the worker resumes **only once the answer has actually been
delivered** to its pane — a worker that is busy stays blocked, and `status` reports
"answered but undelivered" rather than pretending the decision was applied.

## Getting out

| | |
|---|---|
| Advanced early | `hpipe rewind <run> <phase> [--task <id>]` — clears retry counters and any undelivered answer. Rewinding a task to `implement` or earlier also forgets its recorded PR and CI state, which `implement` rediscovers from the branch's open PR; rewinding it to `merge` or earlier forgets a recorded merge and bead close, so the bead reopens for the rework. It refuses a phase that is in no row, or a rewind that would take back a bead another run has adopted since, and rewinding a task to a terminal phase also abandons any decision still open on it |
| Two live runs in one session | `task`, `brief`, `show`, `dispatch`, `release`, `decide` and `answer` resolve against the repo you are standing in and refuse a finished run. If one still cannot tell, it names the candidates — pass `--run <run-id>` |
| A task is escalated | `hpipe rewind <run> <phase> --task <id>` resumes it; `hpipe rewind <run> failed --task <id>` abandons it. The run stays in `execute`, and the task's dependents stay queued, until you do one |
| A task was rewound to `done` without merging | It does not count as landed. If it is the run's only task, the run escalates instead of finishing — `hpipe rewind <run> done` finishes it |
| A task needs more (or less) review than its tier | `hpipe tier --task <id> <tier> --why "<reason>"`. Lowering is refused from pipeline panes; run it from your own |
| A task is stuck behind a failed sibling holding its files | `hpipe release --task <id>` |
| Stop driving a run | `hpipe abort <run>` (undo with `hpipe resume`, which refuses while another run holds one of its beads) |
| Supervisor dead | `hpipe status`, then the `supervisor` action |
| Orchestrator pane died or changed id | Run the `claim` action from the pane that should drive it; `hpipe status` flags this |
| A pane stopped answering (agent exited, usage limit) | Nothing, to keep the run moving: workers still advance, and prompts owed to that pane are held in the run's outbox and sent once it answers again. `hpipe status` lists what is held. Restart the agent, or `claim` a new orchestrator pane |
| A run from an older plugin version | It is not migrated or advanced, and does not block `hpipe start`. Finish it on the release that started it, or `hpipe abort <id>` |
| A task's bead will not close | `hpipe status` shows bd's error once it has failed five times; fix that, or `hpipe close --task <id>` (`--force` only to override bd's close guards) |
| Plugin misbehaving | `herdr plugin disable stein.pipeline` |
| Out permanently | `herdr plugin unlink stein.pipeline`, then `rm ~/.local/bin/hpipe` |

Nothing the plugin owns is load-bearing for the work: runs are bookkeeping, and the artifacts are
files in your repo and objects on GitHub. The backlog is the exception: back up
`$HERDR_PLUGIN_STATE_DIR/beads` (see **Beads**).

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
