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
the file; every dispatch then reports `bootstrap: none`. If the repo has a conventional setup script
(`bin/bootstrap`, `script/bootstrap`, `scripts/bootstrap`) but no `.claude/pipeline-bootstrap`, the
line names it: point a `.claude/pipeline-bootstrap` at it to have it run.

It is also where a sibling package's build step belongs. If your apps consume another package's
built `dist` rather than its source, build it here (`pnpm install && pnpm turbo build
--filter=@repo/core`, say); the plugin itself never names a build command. The script builds
whatever the checkout contains, and a worktree is cut from the `origin/<default branch>` commit
fetched just before the task is dispatched — the `base:` line `hpipe task` and the supervisor's
`Dispatch tN` prompt both print — so a `--depends-on` task sees its merged dependencies whether or
not your local `main` has been pulled. A repo with no `origin` remote falls back to local `main`,
and a failed fetch says so on that line. The merge prompt asks the orchestrator to re-run the
bootstrap after it rebases a branch.

### Permissions the orchestrator needs

The orchestrator pushes, opens and merges PRs, and starts workers. Allow these in the Claude Code
session it runs in before you start a run, or the permission check (and auto mode's classifier) will
stop it partway through, once per command:

    git push · git pull · gh pr create · gh pr merge
    herdr worktree create · herdr agent start · hpipe

For example, `Bash(gh pr merge:*)` under `permissions.allow` in the repo's
`.claude/settings.local.json`. Workers run with `--dangerously-skip-permissions` in their own
worktrees and need nothing.

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

### One PR per batch

By default every task opens its own PR, and each merge cuts its own release. A batch that should ship
as **one** release starts with:

    hpipe start "reader menu" --single-pr [--batch-branch <name>]

`start` fetches origin's default branch and pushes it as the run's **batch branch**
(`batch/<run id without its repo prefix>` unless `--batch-branch` names one). Every task is cut from
the batch branch, reviewed on its branch diff against it, and **lands** on it; no task opens a PR.
Once the last task has landed, the branch review runs on what the batch carries, then the
orchestrator opens one PR from the batch branch into the default branch. CI runs once, on that PR,
and its squash merge ships one release whose notes list every landing. The mode is chosen at start
and never changes: abort and start again, which costs nothing before the first dispatch.

`start --single-pr` refuses, and leaves nothing behind, when:

- this session's supervisor is running but predates single-PR runs — restart it (see **Upgrading**);
- origin's default branch cannot be fetched;
- the name is the default branch's, or one git refuses;
- the repo does not allow squash merges: the PR body's release-note block applies only to a squash;
- the name already exists on origin at another commit. At the same commit it is adopted, so a retry
  after a failed start goes through.

It prints a `batch:` line, a `check:` line, and a recommendation: protect `batch/*` against
force-pushes and deletion with a GitHub ruleset. Landing is gated by git refusing a push that is not a
fast-forward; a `--force` push gets through unless a ruleset forbids it.

**`hpipe submit`.** A single-PR worker ends `implement` with

    hpipe submit --task <id> --title "<conventional title>"

where a per-task worker would open a PR. The title is the task's line in the release notes, so it
must be one conventional line whose type the repo's release-please `changelog-sections` read (or
release-please's defaults with no config): `feet:` is refused, and a type the config hides passes
with a note. `submit` also refuses uncommitted or untracked work, a head origin does not have, a
branch with nothing to land outside `docs/superpowers/`, a re-entry that only merged the batch since
the review sent it back, and a branch with an open PR, which would carry every sibling's commits
into the default branch. Then it runs the repo's check.

**`.claude/pipeline-check`.** An executable the repo declares beside `.claude/pipeline-bootstrap`,
run by `submit` on the pushed tree, with its output logged under the run's `.checks/` directory and
the last 40 lines printed on failure. With no per-task CI it is the only test a landed tree gets
before the final PR, so a repo wants one before its first single-PR run. With none, `submit` records
the landing as unchecked, the workers fall back to running the tests themselves, and `hpipe status`
says so. A check longer than an agent's 10-minute Bash timeout does not fit.

**Landing, one at a time.** A task whose last review clears waits in `land-queue`. One task at a
time takes the landing slot, oldest first, among the tasks that have an agent or need no sync:

- **up to date and checked** — its reviewed head contains the batch head, and the check ran on that
  head — goes to `merge`, where the orchestrator lands it with the printed
  `git -C '<repo>' push origin <sha>:refs/heads/<batch>`. No force: if anything landed meanwhile, git
  refuses it, and the task syncs.
- **behind**, or carrying a reviewer's inline fix the check never saw, goes to `sync`: the worker
  merges the batch in, pushes, and runs `hpipe submit` again, which runs the check.

What lands is the head the last review cleared, never the branch tip: a push to the branch after its
review sends the task back through `sync`, so it lands reviewed. A **clean** sync — every commit since
the reviewed head an automatic merge of the batch, by `git merge-tree` — lands without another
review. Anything else, a hand-resolved conflict or a new commit, goes back through the task's reviews
first. A holder that has not submitted within `STALL_MINUTES` while another task waits gives the slot
up, and a paneless task that must sync waits for an agent the orchestrator starts in its worktree.
A task's bead closes when it lands, naming the batch branch; its code reaches the default branch only
with the batch PR.

**The final PR.** After the branch review, `ship` has the orchestrator bring the batch checkout
(`$HERDR_PLUGIN_STATE_DIR/checkouts/<run>`) up to date, run `hpipe batch-check` there — the one run of
every landing together, which records the head it passed on — and open the PR with the body the
plugin renders: one line per landing between `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE`. The
PR clears `ship` only at a head `batch-check` recorded. `ship-ci` waits for CI on its head. A red one
is the orchestrator's: an empty commit for an environmental failure, a subagent's patch in the batch
checkout for a small defect, or a fix task — `hpipe task …` registers it into the run and moves it
back to `execute` — for a bigger one. The batch PR gets one repair; a second red escalates the run.
`ship-merge` renders the squash merge, whose commit carries the same lines, so the release reads them
even if release-please never finds the PR body.

**Clean-up.** The `done` notice, and `hpipe abort`, print it: `git push origin --delete` for each task
branch whose head is on the batch, a warning for any branch with commits that did not land, and the
removal of the batch checkout and the local batch branch.

## Review tiers

Every task carries a tier that decides which reviews it runs:

| Tier | `spec-review` | `plan-review` | PR review |
|---|---|---|---|
| `light` | ✓ | – | one combined `pr-review` |
| `standard` | ✓ | ✓ | one combined `pr-review` |
| `heavy` | ✓ | ✓ | one combined `pr-review` |

Heavy used to review the PR twice, `pr-review-intent` then `pr-review-quality`. The intent stage
cleared all 66 of its reviews, and the one PR-stage defect in 254 berean-os verdicts came from a
combined review, so heavy now differs from standard in review effort, not in review count (see
**Models**).

The orchestrator sets it at registration with `--tier light|standard|heavy`; a new task defaults to
`standard`. A bead labelled `pipeline:tier-light`, `pipeline:tier-standard` or `pipeline:tier-heavy`
overrides `--tier`, and a bead carrying two tier labels is refused. Labels are read once, at
registration, and `hpipe task` prints the result as `tier: <tier> (<why>)`.

Mid-run, `hpipe tier --task <id> <tier> --why "<reason>"` changes it. Raising works from any pane;
lowering is refused from the orchestrator's and the workers' panes, so run it from your own. The
phase the task is in always completes; only the next step follows the new tier, and a raise never goes
back for a review already skipped (`hpipe rewind` does). `hpipe show --task <id>` prints the tier, its
log, and every phase the task visited.

Every task review ranks its findings the same way. Only a **BLOCKER** sends the work back for another
pass, and a BLOCKER is a defect that would ship or a product or scope decision only the owner can make.
A **MAJOR** changes shipped behaviour or a verification outcome and is fixed inline; a process question
(a shared file, a flagged departure from the spec, a base that moved) is at most a MAJOR, fixed inline
or put to the orchestrator with `hpipe decide`. A review reports at most five MINORs.

**A small, well-planned change skips its PR review.** When a light or standard task leaves
`implement`, the supervisor sizes the change with `git diff --numstat` from its merge base with the
base as just fetched (the PR's base per-task, the batch branch single-PR) to the pushed head. The task
goes straight to `ci` (`land-queue` in a single-PR run) when all of these hold:

- it adds fewer than 150 lines outside `docs/` (`PR_REVIEW_SKIP_BELOW_ADDED_LINES` in
  `src/lib/review-skip.ts`);
- its `spec-review`, and its `plan-review` where the tier runs one, each cleared on the first pass,
  and no PR review has sent it back;
- it touches no path on the repo's always-review list.

Heavy never skips, and a git read that fails means the review runs. The history records why, as
`pr-review skipped: 42 lines added outside docs/, spec-review and plan-review cleared first pass`;
`hpipe status` marks the task `pr-review skipped`, `hpipe show` prints a `skipped:` line, the digest
shows `[implement → ci, pr-review skipped]`, and the merge prompt says the review was skipped. In a
single-PR run the head that lands is recorded exactly as a clearing review records it, so a push
after `submit` still goes through `sync` and the check. A run's final `branch-review`, when it runs,
reads every change either way. On berean-os, none of the 13 tasks with a sound plan and a change under
~150 lines drew a behavioural PR finding; the one real PR-stage defect after a sound plan came on a
784-line diff.

**`.claude/pipeline-always-review`** lists what is always reviewed: one path prefix per line, `#`
starts a comment, and a glob is cut to the prefix before its first wildcard. It is read from the
base the change is sized against, not from the task's branch, so a change cannot take itself off the
list. No file means an empty list.

A run in which at most one task landed skips the final `branch-review` and finishes. Either way,
the orchestrator is sent a short notice when its run reaches `done`, saying where each task ended.

## Beads

Each repo's backlog is its own [Beads](https://github.com/gastownhall/beads) database, kept in the
plugin's state dir at `$HERDR_PLUGIN_STATE_DIR/beads/<repo>-<hash>/` — never in your repo, and out of
reach of every worker worktree. hpipe is its only writer: every write runs as actor `hpipe`, one call
at a time under a lock, and the supervisor converges each bead to what the run's ledger says — claimed
while its task is worked, blocked while a decision or an escalation waits on you, blocked by the
holder's bead while it waits on another task's `--files`, released if the task is abandoned or the run
aborted, closed once its PR merges. The close is the supervisor's; nobody is prompted for it.
A bead's fine phase is a label naming it bare (`research`, `spec-review`, or `aborted` once a run is
aborted); the run driving it is bead metadata `hpipe.run`, which `hpipe bead show` prints as `run:`.
A label of your own that equals a phase name (say `plan`) on an adopted bead becomes hpipe's to swap.
The `phase:<name>` labels earlier builds wrote are removed on the next tick.

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

**The store's history.** bv's history view reads git, so each store is its own git repo: after every
change hpipe commits the export, `.beads/issues.jsonl`, as `hpipe <hpipe@localhost>` — one commit per
CLI write and one per supervisor pass that wrote. Nothing else is tracked (the Dolt data stays out),
the repo has no remote, and your git config, hooks and signing never apply to it. A store made by an
earlier release becomes a repo at its next change or the next time its board opens; a board already
open from before the upgrade keeps showing `History load failed` until you reopen it with **Open
board**. A commit that fails is logged once and never fails the write. Do not commit to the repo
yourself, and do not take it for a backup: it holds the export, not the database.

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

Effort is pinned by tier, not inherited. A worker starts with `--effort` from its tier, and every
review subagent is dispatched with an `effort:` from its task's current tier and the review it runs:

| Tier | Worker | `spec-review`, `pr-review` | `plan-review` |
|---|---|---|---|
| `light` | `medium` | `high` | – |
| `standard` | `high` | `high` | `medium` |
| `heavy` | `xhigh` | `xhigh` | `xhigh` |

The plan review is cheaper below heavy because it no longer dry-runs the plan: it reads it for spec
coverage, behaviour no test would see, the `FILES:` lock and steps that would mislead the
implementer, and leaves compile and command errors to the implementer's own red/green loop. `hpipe
task` and `hpipe show` print the split, as `effort: worker high, reviews high (plan-review medium)`.

The branch review runs at the heaviest task's review effort. A worker's effort is fixed when its agent
starts, so `hpipe tier` changes only the reviews that follow; `hpipe show` prints both. Inheriting the
default ran seven workers and every reviewer at `xhigh`, and a 5-hour usage window lasted 31 minutes.

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

The combined-PR-review release keeps the `pr-review-intent` and `pr-review-quality` rows but routes
no task into them. A heavy task already in one when you upgrade finishes that review and goes on to
`ci` (or `land-queue` in a single-PR run), skipping the second stage; a BLOCKER from it sends the task
back to `implement`, which then opens the combined `pr-review`. No ledger format changes. The
PR-review skip adds one optional task field, `review_skip`, which an earlier release ignores: a
supervisor still on it reviews every PR, as before.

Single-PR runs are written as `schema_version: 4`, and per-task runs stay at 3, so every run in
flight carries on across the upgrade and a rollback still reads them. A supervisor that predates
single-PR runs ignores a v4 run rather than driving it as a per-task one, and `hpipe start --single-pr`
refuses while this session's live supervisor is that old: restart it first.

Upgrade the `hpipe` on your PATH together with the plugin: an older one reads a v3 ledger without
complaint and gets it wrong — a v1.7.1 left at `~/.local/bin/hpipe` briefed `issue #undefined` in a
smoke run. A link to `bin/hpipe` follows the installed plugin by itself; replace anything else there,
a copy or a link into another checkout, with the **Install the hpipe shorthand** action.

## Answering a decision

    hpipe answer --task <id> --decision <id> --answer "…" --by orchestrator|human [--run <run-id>]

The answer is recorded immediately but the worker resumes **only once the answer has actually been
delivered** to its pane — a worker that is busy stays blocked, and `status` reports
"answered but undelivered" rather than pretending the decision was applied.

## Claude's usage limit

When Claude's usage limit stops an agent, its pane shows `You've hit your session limit · resets
10:20am (America/Managua)` and herdr reports it idle. The supervisor reads that line, from the
screen it already reads before every send and from each pane that goes idle, and holds the pane
until the reset:

- nothing is typed into it: prompts and digests wait in the outbox;
- its stall ladder stops: no probe, no escalation, however long the outage;
- 90 s after the reset it restarts every ladder waiting on the pane. A worker still stopped where
  the limit left it gets one `Usage limit lifted` prompt telling it to carry on, without starting
  the phase over, and the orchestrator hears once what resumed.

Nothing is resumed twice. A worker whose phase prompt is queued, whose phase changed meanwhile,
that was never briefed, or that Claude's own auto-continue is resuming, gets no resume prompt.
`hpipe status` shows `paused by Claude's usage limit, resets …` against each worker, and
`⚠ usage limit in <pane>` for what is held.

If a worker is still idle a few minutes after the reset:

    hpipe nudge --task <id> | --all [--run <run-id>]

It queues the same resume, restarts the ladder and releases the supervisor's hold. It changes no
phase, pass count, verdict or history, unlike a same-phase `rewind`, which restarts the phase from
the top. It acts only on a worker whose pane still shows the limit line or that the supervisor is
holding for one. When the reset could not be read, the hold stays until the pane moves on or you
nudge it, and status lists that worker under "waiting on you".

The limits are kept in `delivery.<session>.json` in the state dir, so a supervisor restarted
mid-outage carries them on.

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
| A pane stopped answering (agent exited) | Nothing, to keep the run moving: workers still advance, and prompts owed to that pane are held in the run's outbox and sent once it answers again. `hpipe status` lists what is held. Restart the agent, or `claim` a new orchestrator pane |
| Workers idle after Claude's usage limit | Nothing: the supervisor resumes them at the reset (see **Claude's usage limit**). If one is still idle a few minutes after, `hpipe nudge --task <id>`. Never `rewind` to the same phase for this |
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
