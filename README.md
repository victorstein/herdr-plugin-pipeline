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

`hpipe dispatch` runs it in each new checkout, from that checkout's own copy, before it starts the
worker, and the worker's
brief names it as the recovery if a build fails on a missing dependency. It runs from the worktree
root and **must be idempotent** — it can run more than once. Its output goes to
`$HERDR_PLUGIN_STATE_DIR/runs/<session>/<run>.dispatch/<task>-bootstrap.log`, and a run that fails
prints the last 40 lines. A bootstrap that passed is recorded for that checkout, so a dispatch run
again after a later step failed does not repeat it. One still running after 20 minutes is stopped with
everything it started; a bootstrap that really needs longer is run by hand, as the message says. A
repo that needs nothing simply omits the file; every dispatch then reports `bootstrap: none`. If the
repo has a conventional setup script (`bin/bootstrap`, `script/bootstrap`, `scripts/bootstrap`) but no
`.claude/pipeline-bootstrap`, the line names it and `hpipe dispatch` does not run it; the
`dispatch, in order:` block carries it as an optional step in the new checkout. Point a
`.claude/pipeline-bootstrap` at it to have it run every time. herdr picks the new checkout's path, so
the block names it by where `worktree create`'s JSON gives it, `.result.worktree.path`, and
`hpipe show --task <id>` prints it once herdr reports the worktree.

It is also where a sibling package's build step belongs. If your apps consume another package's
built `dist` rather than its source, build it here (`pnpm install && pnpm turbo build
--filter=@repo/core`, say); the plugin itself never names a build command. The script builds
whatever the checkout contains, and a worktree is cut from the `origin/<default branch>` commit
fetched just before the task is dispatched — the `base:` line `hpipe task` and the supervisor's
`Dispatch tN` prompt both print — so a `--depends-on` task sees its merged dependencies whether or
not your local `main` has been pulled. A repo with no `origin` remote falls back to local `main`,
and a failed fetch says so on that line. The merge prompt asks the orchestrator to re-run the
bootstrap after it rebases a branch.

### Paths every task may edit at once

`--files` is a lock: two tasks whose path prefixes overlap never implement at the same time, and the
second waits in `blocked-on-files` until the first finishes. A file every task appends to — a format
reference, a registry, a changelog — would serialize the whole batch on it. List such paths in
`.claude/pipeline-shared-paths` at the repo root, on the default branch:

    # every task adds a section of its own
    docs/file-formats.md
    CHANGELOG.md

One path prefix per line; `#` starts a comment, and a leading `./` or `/` is dropped. A prefix is a
plain prefix, as a `--files` entry is, so `docs/file-formats` also covers `docs/file-formats-old/`. A
line with a glob character (`*?[{`) is ignored rather than cut to its prefix, which would share far
more than it names (`docs/*.md` would share all of `docs/`), and so is a line that would share the
whole repo (`/`, `.`). `hpipe start` warns about each.

A shared path never holds the lock. A task still declares it in `--files`, and `hpipe task` and
`hpipe show` print it marked `(shared)`; it just locks nothing, so a task whose every entry is shared
goes straight past `blocked-on-files`. An entry broader than a shared prefix still locks: `docs/`
claims the rest of `docs/` even when `docs/file-formats.md` is shared.

Two tasks now edit one file at once, so a conflict there is expected, and the flows that already
exist resolve it. The implementer is asked to keep its change to a shared file self-contained — a
section of its own, nobody else's reflowed or reordered — so a merge stays mechanical. Per-task, the
merge prompt names the shared path and any merged task that declares it too: rebase, keep both sides'
additions, and CI runs again on the rebased head; two additions that collide in meaning (the same id,
number or section) go back to `implement` with the `hpipe rewind` the prompt prints, so the worker
redoes its addition on top and it is reviewed. In a single-PR run the conflict comes at `sync`: the
worker keeps both additions, which makes the sync dirty, so the change goes back through review; a
collision in meaning is raised with `hpipe decide`.

`hpipe start` reads the list **once**, from the commit the run is cut from — origin's default branch as
just fetched, or a single-PR run's batch base — and prints a `shared:` line naming that commit.
Nothing refreshes it mid-run: a list that shrank could leave two tasks past the gate on a path that
locks again. A change to the file takes effect at the next `start`, and `hpipe status` names the
snapshot's commit under the run header. The file is otherwise an ordinary path: not shared itself, and
a change to it is always reviewed, since it changes how every later run locks. An unreadable file
shares nothing, which locks every path as before; `start` warns and goes ahead.

### Permissions the orchestrator needs

The orchestrator pushes, opens and merges PRs, and starts workers. Allow these in the Claude Code
session it runs in before you start a run, or the permission check (and auto mode's classifier) will
stop it partway through, once per command:

    git push · git pull · gh pr create · gh pr merge · hpipe

For example, `Bash(gh pr merge:*)` under `permissions.allow` in the repo's
`.claude/settings.local.json`. Workers run with `--dangerously-skip-permissions` in their own
worktrees and need nothing.

`hpipe dispatch` runs `herdr worktree create` and `herdr agent start … --dangerously-skip-permissions`
itself, so allowing `hpipe` allows starting workers that skip permissions, and auto mode's classifier
sees only `hpipe dispatch --task t1`, never the `agent start` inside it. `herdr worktree create` and
`herdr agent start` are needed only for the manual fallback.

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

When tasks are ready the orchestrator dispatches them with one command, run in the background:

    hpipe dispatch --ready [--run <run-id>]        # every task waiting for its brief
    hpipe dispatch --task <id> [--run <run-id>]    # one task

For each task it fetches the base, creates the task's worktree from it with `--cwd` pinned to the
repo, runs `.claude/pipeline-bootstrap` in the new checkout, starts the worker with
`--dangerously-skip-permissions` at its tier's effort, and hands it the brief. It prints one line per
step as it goes, skips any step already done, and stops at the first failure with what to do next; run
the same command again once that is fixed. Only one dispatch runs in a repo at a time, across
sessions, and only from a pane of the run's own herdr session. `--ready` also takes any task that
becomes ready while it runs. SIGTERM, SIGINT or SIGHUP stops a dispatch's bootstrap with it; one
killed outright leaves its lock, and the next dispatch in the repo stops that bootstrap and takes the
lock over. A herdr call that hangs past 30 seconds (90 for `agent start`) is stopped, and the dispatch
stops at that step and lets go of the lock. While a dispatch is under way, `hpipe status` says what it
is doing rather than asking for an agent to be started. Beside a supervisor that predates it, `--task`
and `--ready` refuse, naming its pid: restart it (see **Upgrading**), or use the manual fallback.

The manual fallback is the `dispatch, in order:` block `hpipe task` and the `Dispatch tN` prompt print,
ending in:

    hpipe dispatch --task <id> --pane <pane-id> [--run <run-id>]

which submits the rendered brief to an agent you started over `herdr agent prompt`, and exits
non-zero unless herdr sees the worker start on it. The brief cannot ride on `herdr agent start`
itself: herdr refuses to pass an argument containing its fences and backticks. Both forms claim the
task's bead first; if bd refuses the claim, nothing is sent. When the batch is complete the
orchestrator closes intake with `hpipe dispatch --done`. Everything after that is injected: each
worker gets its next instruction as each phase completes.

`hpipe status` shows the fleet, every open decision, and anything waiting on you. For one task:

| | |
|---|---|
| `hpipe show --task <id> [--run <run-id>]` | What the run recorded: branch, bead, surface, files (a shared one marked), dependencies, phase and its age, artifact and verdict paths, PR, CI, open decision |
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
and carries the question as a comment until you answer. A check only you can make before a merge, a
device test say, holds that merge until you rule on it (**Before-merge checks**).

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
force-pushes and deletion with a GitHub ruleset, unless GitHub says a ruleset already does. The `ship`
prompt repeats the recommendation unless start recorded that answer as yes; it does not ask GitHub
again. Landing is gated by git refusing a push that is not a fast-forward; a `--force` push gets
through unless a ruleset forbids it.

**`hpipe submit`.** A single-PR worker ends `implement` with

    hpipe submit --task <id> --title "<conventional title>"

where a per-task worker would open a PR. The title is the task's line in the release notes, so it
must be one conventional line whose type the repo's release-please `changelog-sections` read (or
release-please's defaults with no config): `feet:` is refused, and a type the config hides passes
with a note. `submit` also refuses uncommitted or untracked work, a head origin does not have, a
branch with nothing to land outside `docs/superpowers/`, a re-entry that only merged the batch since
the review sent it back, and a branch with an open PR, which would carry every sibling's commits
into the default branch; when GitHub cannot say whether there is one, it refuses too. Then it runs
the repo's check. An `implement` head that lacks the batch head as just fetched is still recorded, and
`submit` says the batch moved, so the task goes through `sync` before it lands. Because the pipeline's own documents do not count as something to land, a task
whose whole deliverable is a document under `docs/superpowers/` can never be submitted: run such a
task per-task, or keep its document elsewhere.

**`.claude/pipeline-check`.** An executable the repo declares beside `.claude/pipeline-bootstrap`,
run by `submit` on the pushed tree, with its output logged under the run's `.checks/` directory and
the last 40 lines printed on failure. With no per-task CI it is the only test a landed tree gets
before the final PR, so a repo wants one before its first single-PR run. With none, `submit` records
the landing as unchecked, the workers fall back to running the tests themselves, and `hpipe status`
says so. `submit` stops a check still running after 9 minutes, with everything it started, and
refuses: an agent's Bash call times out at 10, so a longer suite does not fit.

**Landing, one at a time.** A task whose last review clears waits in `land-queue`. One task at a
time takes the landing slot, oldest first, among the tasks that have an agent or need no sync:

- **up to date and checked** — its reviewed head contains the batch head, and the check ran on that
  head or on the submission it adds only review verdicts to, which the landing prompt names — goes to
  `merge`, where the orchestrator lands it with the printed
  `git -C '<repo>' push origin <sha>:refs/heads/<batch>`. No force: if anything landed meanwhile, git
  refuses it, and the task syncs.
- **behind**, or carrying a reviewer's inline fix the check never saw, goes to `sync`: the worker
  merges the batch in, pushes, and runs `hpipe submit` again, which runs the check.

What lands is the head the last review cleared, never the branch tip: a push to the branch after its
review sends the task back through `sync`, so it lands reviewed. A **clean** sync — every commit since
the reviewed head an automatic merge of the batch, by `git merge-tree` — lands without another
review. Anything else, a hand-resolved conflict or a new commit, goes back through the task's reviews
first. A holder that has not submitted within `STALL_MINUTES` while another task waits gives the slot
up, unless its worker is still at work, and a paneless task that must sync waits for an agent the
orchestrator starts in its worktree.
A task's bead closes when it lands, naming the batch branch; its code reaches the default branch only
with the batch PR.

**The final PR.** After the branch review, `ship` has the orchestrator bring the batch checkout
(`$HERDR_PLUGIN_STATE_DIR/checkouts/<run>`) up to date, run `hpipe batch-check` there — the one run of
every landing together, which records the head it passed on — and open the PR with the body the
plugin renders: one line per landing between `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE`. The
PR clears `ship` only at a head `batch-check` recorded. `ship-ci` waits for CI on its head, and a head
pushed after the check, in `ship-ci` or `ship-merge`, sends the run back to `ship` for another
`batch-check`; a red seen on it is still the PR's red. A red one
is the orchestrator's: an empty commit for an environmental failure, a subagent's patch in the batch
checkout for a small defect, or a fix task — `hpipe task …` registers it into the run and moves it
back to `execute` — for a bigger one. The batch PR gets one repair; a second red escalates the run.
`ship-merge` renders the squash merge, whose commit carries the same lines, so the release reads them
even if release-please never finds the PR body.

**Clean-up.** The `done` notice, and `hpipe abort`, print it: `git push origin --delete` for each task
branch whose head is on the batch, a warning counting the commits of any branch that did not land, and
the removal of the batch checkout and the local batch branch, each only once it exists.

## Review tiers

Every task carries a tier that decides which reviews it runs:

| Tier | `spec-review` | `plan-review` | PR review |
|---|---|---|---|
| `light` | ✓ | – | one combined `pr-review`, skipped for a small change (below) |
| `standard` | ✓ | ✓ | one combined `pr-review`, skipped for a small change (below) |
| `heavy` | ✓ | ✓ | one combined `pr-review`, never skipped |

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
log, and every phase the task visited, leaving out a file gate it passed straight through.

Every task review ranks its findings the same way. Only a **BLOCKER** sends the work back for another
pass, and a BLOCKER is a defect that would ship or a product or scope decision only the owner can make.
A **MAJOR** changes shipped behaviour or a verification outcome and is fixed inline; a process question
(a shared file, a flagged departure from the spec, a base that moved) is at most a MAJOR, fixed inline
or put to the orchestrator with `hpipe decide`. A review reports at most five MINORs. On a `CLEAR`,
the worker fixes the MAJORs and MINORs it lists in the same turn and pushes the fixes with the verdict.

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
`pr-review skipped: 42 lines added outside docs/, spec-review and plan-review cleared first pass`,
and a light or standard task that keeps its review says why too, as `reviewed: 167 lines added
outside docs/ (a skip needs fewer than 150)`, `reviewed: <path> is on .claude/pipeline-always-review`
or `reviewed: plan-review sent it back`;
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
list, and a change to the file itself is always reviewed. A single-PR run reads it from its batch
branch, cut from the default branch at `hpipe start`, so add to it before the run starts. No file
means an empty list.

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
the store exists the prefix is fixed, and a `--prefix` that disagrees is ignored with a ⚠ line, first
in `start`'s output, naming the prefix in use. The action uses the default prefix,
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

| Tier | Worker | `spec-review` | `pr-review` | `plan-review` |
|---|---|---|---|---|
| `light` | `medium` | `high` | `high` | – |
| `standard` | `high` | `high` | `high` | `medium` |
| `heavy` | `high` | `xhigh` | `high` | `high` |

The plan review is cheaper below heavy because it no longer dry-runs the plan: it reads it for spec
coverage, behaviour no test would see, the `FILES:` lock and steps that would mislead the
implementer, and leaves compile and command errors to the implementer's own red/green loop. `hpipe
task` and `hpipe show` print the split, as `effort: worker high, reviews high (plan-review medium)`.

Heavy keeps `xhigh` only for its spec review, which is where the reviews caught defects that would
have shipped. On the 2026-10-12 berean-os run, `xhigh` for the worker and every review cost a heavy
task about 30% more than `medium` while those reviews cleared first time.

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
flight carries on across the upgrade and a rollback still reads them. A batch started with a ruleset
already protecting it carries the optional `ruleset_protected` field, which an earlier release ignores;
a batch started before it repeats the ruleset advice at `ship`. A supervisor that predates
single-PR runs ignores a v4 run rather than driving it as a per-task one, and `hpipe start --single-pr`
refuses while this session's live supervisor is that old: restart it first.

Restart the supervisor before using this release's CLI on a run in `branch-review` or a shipping
phase (`ship`, `ship-ci`, `ship-merge`). The supervisor renders those phases' prompts and reserves the
branch review, so beside an old one a new CLI still gets a batch merge command with no
`--match-head-commit` and a branch review git can see. The release adds optional fields an earlier one
ignores: a sync submission's `merges` (an old supervisor calls any clean sync a clean sync) and an
outbox entry's `carry-on` kind (an old supervisor delivers it but does not count it as a resume).

2.2.0 — shared paths, before-merge checks and one-command dispatch — adds only optional fields, and no
schema change: `shared_paths` on a run, `before_merge` on a task and on a run, `bootstrapped` on a task,
and `capabilities` in the supervisor's pid file, which lists what that supervisor honours so the CLI can
tell an older one from this release's. Restart the supervisor in every session, as above. Until you do,
the older supervisor ignores every new field, and the CLI makes up for it where it can: `hpipe start`
warns that it locks every declared path, shared or not, which is only stricter, and a restart lets the
run share them; `hold` and `answer --before-merge` refuse until this session's supervisor is restarted,
since it would send the merge command whatever check is owed; and `hpipe dispatch --task` and `--ready`
refuse as well, since it reads no dispatch lock and would probe a task mid-bootstrap. The manual
fallback, the `dispatch, in order:` block ending in `hpipe dispatch --task <id> --pane <pane-id>`, still
works beside it. Runs started before the upgrade carry no shared-path list and keep locking everything
until they finish. Rolling back to 2.1 ignores the fields rather than removing them: shared paths lock
again, which is safe, and `bootstrapped` is ignored, but every hold is dropped, so the earlier
supervisor sends the merge command and probes as before. Confirm or waive every owed check before
rolling back, or tell the user the hold is gone.

2.2.2 adds the outbox kinds `abort` and `run-resumed`, an outbox entry's optional `brief_chars`, a run's optional
`aborted_escalation_from`, and the supervisor capability `abort-notice`. An older supervisor drops a brief whose phase
prompt went stale before an agent took it, as before.
An older supervisor drops a finished run's task prompts, so it never delivers `hpipe abort`'s stop
notices: the abort says so and names the restart, and the notices wait in the outbox for a supervisor
that delivers them. `hpipe resume` withdraws any still unsent.

Upgrade the `hpipe` on your PATH together with the plugin: an older one reads a v3 ledger without
complaint and gets it wrong — a v1.7.1 left at `~/.local/bin/hpipe` briefed `issue #undefined` in a
smoke run. A link to `bin/hpipe` follows the installed plugin by itself; replace anything else there,
a copy or a link into another checkout, with the **Install the hpipe shorthand** action.

## Answering a decision

    hpipe answer --task <id> --decision <id> --answer "…" --by orchestrator|human \
                 [--before-merge "<check>"]... [--run <run-id>]

The answer is recorded immediately but the worker resumes **only once the answer has actually been
delivered** to its pane — a worker that is busy stays blocked, and `status` reports
"answered but undelivered" rather than pretending the decision was applied. `--before-merge` records
a check only the user can make, in the same save; see **Before-merge checks**.

## Before-merge checks

Some checks only the user can make: a test on a device, a look at the UI. Record one, and the merge it
guards waits for the user's ruling:

    hpipe answer … --before-merge "<what they check>"      # carried by a decision's answer
    hpipe hold --task <id> --before-merge "<check>"         # one task's merge, with no decision behind it
    hpipe hold --before-merge "<check>"                     # single-PR: the batch PR

`--before-merge` may be repeated: each one is a check, numbered `c1`, `c2`, … across the run, and a
comma is part of its text. Per-task, a check holds its task's merge. Single-PR, every check, on a task
or on the run, holds the batch PR, never a task's landing: one task lands at a time, so a landing held
for the user would hold every landing behind it, and the batch PR's head is what ships.

While a check is owed:

- The merge command is never sent. The orchestrator gets **Hold — … waits on the human before it
  merges** instead, which has it make the PR mergeable first (by `gh pr view --json
  mergeStateStatus`: a rebase, `gh pr update-branch`, `gh pr ready`), since a rebase replaces the head
  the user would check; then tell the user once, in a message of its own, what to check and on which
  build; then end its turn.
- No stall probe comes for it, however long the user takes.
- `hpipe status` lists it under **waiting on the human:** once its gate is reached, and the run header
  gets a `before merge:` line as soon as it is recorded. Until the gate, that line says when the user
  is asked, not that anyone waits on them: `owed before PR #12 merges; the human is asked at merge`
  (single-PR: `at ship-merge`). `hpipe show --task <id>` prints one `before merge:` line per check.
  Per-task, the task's bead is `blocked` + `hpipe:awaiting-human`, with the check and each ruling as
  comments.

The user's ruling is recorded with:

    hpipe confirm --check <id> --by human                    # they checked it, and it holds
    hpipe confirm --check <id> --by human --waive "<why>"    # they chose to skip it
    hpipe confirm --check <id> --by human --failed "<what they saw>"

- **What a confirmation covers.** The head CI ran on, read live from origin. It holds only while
  that is the head that merges: a push after it makes the check owed again, on the new head. A waiver
  covers any head.
- **When.** Only near the gate: per-task while the task is in `ci` or `merge`, or once its PR has
  merged; single-PR while the run is in `ship-ci` or `ship-merge`. Only `--by human` is taken, and
  never from a worker's pane.
- **What it does.** The last ruling at the gate queues the merge prompt and restarts the stall ladder.
  A per-task `--failed` sends the task back to `implement`, and its worker is told what the user saw.
  A single-PR one keeps the run in `ship-merge` until a patch on the batch or a fix task moves the
  head, which the user then checks again. After the merge `--failed` is refused: record `--waive
  "failed on device; fixed by <task>"`, and register the fix as a new task.

A PR merged by hand while a check is owed is recorded, since it is GitHub's fact, but the task waits in
`merge` (single-PR, the run in `ship-merge`) until the user rules. Its bead stays open, it can be
rewound only back to `merge` (any other phase would finish it or forget the merge), `hpipe close` is
refused, and a per-task run cannot reach `done`. `hpipe abort` lists
what is still owed, and the done notice says what was ruled.

`hold` and `answer --before-merge` refuse beside a supervisor that predates before-merge checks, which
would send the merge command anyway: restart it first (see **Upgrading**).

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
the top. It acts on a worker whose pane still shows the limit line or that the supervisor is
holding for one, and on a worker that stopped in its phase with uncommitted work — the digest's
`YOUR move: worker idle with N uncommitted paths (…)` — which it tells to commit, push and finish
the phase. It refuses a worker whose pane shows background work running (see **Background work**).
When the reset could not be read, the hold stays until the pane moves on or you nudge it, and
status lists that worker under "waiting on you".

The limits are kept in `delivery.<session>.json` in the state dir, so a supervisor restarted
mid-outage carries them on.

## Background work

herdr reads a Claude pane as `done` once its turn ends, whatever the turn left running behind the
prompt: its claude manifest counts `Waiting for N background agents to finish` and `N MCP tasks still
running` as work, and no shell or monitor. The supervisor reads Claude Code's footer for the rest —
the pill in `⏵⏵ bypass permissions on · 1 shell, 4 monitors · ← 1 agent`, and the agents panel's
`◯ ui-dev  Waiting on x4pro firmware build …` rows — from the screen it already reads when a pane
goes idle, and reads a pane again once a minute while it shows work. Only the footer line is read,
never the status line beside it. Work is a shell, a monitor, a local agent, a team, a background or
remote workflow, a cloud session, an MCP task, or a mix of them; `dreaming`, `auto-mode scan`, a memory
import and an Artifact comment monitor are not. `← 1 agent` is the hint for the agents view, which a
fresh session shows too; it is not work either. While a pane shows background work:

- its uncommitted work is not reported as a stop, and `hpipe nudge` refuses it;
- the stall ladder holds the escalation as it does for a working pane, within the same cap;
- the digest's line says so: `agent:done, background work running (1 shell, 4 monitors, ui-dev
  subagent)`.

Only a subagent — a row in the agents panel, or the pill's `N local agents` — holds a phase back,
because it may still be writing the artifact the phase is waiting for. Once a worker's artifact,
verdict, submission or sync is there, or the run's branch review is, the phase waits for the subagent
to finish, for at most 10 minutes, then advances anyway and its history says it went past it. A
shell, a monitor or any other kind never holds a phase: an orchestrator that waits for a phase change
with a background shell polling `hpipe status` would otherwise hold the very phase it waits for. So
waiting for a phase change is done by ending the turn: the next prompt arrives on its own. The
orchestrator's own work never holds the task rows it owns, such as `merge`, and `ship` is not held
at all: those clear on GitHub's or the batch's facts.

Claude Code runs subagents in the background, so no prompt asks an agent to wait for one within its
turn: every prompt that dispatches one says to end the turn and carry on when the subagent's
completion notice arrives, and never to poll for its output or sleep. A worker's review verdict is
therefore written while the worker sits idle, and the subagent can leave the panel a moment before
its notice starts the worker's next turn. So a worker's review row also waits, with no cap, until the
worker has committed its verdict, which it does last, once it has handled the notice: a `BLOCKER`'s
pushed before that turn ends, a `CLEAR`'s with the fixes it asked for. The next prompt cannot
overtake either.

## Getting out

| | |
|---|---|
| Advanced early | `hpipe rewind <run> <phase> [--task <id>]` — clears retry counters and any undelivered answer. Rewinding a task to `implement` or earlier also forgets its recorded PR and CI state, which `implement` rediscovers from the branch's open PR; rewinding it to `merge` or earlier forgets a recorded merge and bead close, so the bead reopens for the rework. It refuses a phase that is in no row, or a rewind that would take back a bead another run has adopted since, and rewinding a task to a terminal phase also abandons any decision still open on it |
| Two live runs in one session | `task`, `brief`, `show`, `dispatch`, `release`, `decide` and `answer` resolve against the repo you are standing in and refuse a finished run. If one still cannot tell, it names the candidates — pass `--run <run-id>` |
| A task is escalated | `hpipe rewind <run> <phase> --task <id>` resumes it; `hpipe rewind <run> failed --task <id>` abandons it. The run stays in `execute`, and the task's dependents stay queued, until you do one |
| A task was rewound to `done` without merging | It does not count as landed. If it is the run's only task, the run escalates instead of finishing — `hpipe rewind <run> done` finishes it |
| A task needs more (or less) review than its tier | `hpipe tier --task <id> <tier> --why "<reason>"`. Lowering is refused from pipeline panes; run it from your own |
| A task is stuck behind a failed sibling holding its files | `hpipe release --task <id>` |
| Stop driving a run | `hpipe abort <run>`. It tells every briefed worker still in a phase to stop, keeps their agents and worktrees, and lists what to remove if you will not resume: each task worktree, the unlanded branches and, in a single-PR run, the batch branch. `hpipe status` heads it `[aborted]`. `hpipe status` also lists any stop notice not yet delivered. Undo with `hpipe resume`, which tells the stopped workers to carry on and withdraws a stop notice not yet sent. A worker pane lost while the run was aborted fails nothing: the resume sees that the task's next agent gets its brief and phase prompt, queued or by `hpipe dispatch` in `research`, and names the commands that start one. It refuses from a worker's pane, and while another run holds one of its beads. An aborted run is resumed before it is rewound |
| Supervisor dead | `hpipe status`, then the `supervisor` action |
| Orchestrator pane died or changed id | Run the `claim` action from the pane that should drive it; `hpipe status` flags this |
| A pane stopped answering (agent exited) | Nothing, to keep the run moving: workers still advance, and prompts owed to that pane are held in the run's outbox and sent once it answers again. `hpipe status` lists what is held. Restart the agent, or `claim` a new orchestrator pane |
| Workers idle after Claude's usage limit | Nothing: the supervisor resumes them at the reset (see **Claude's usage limit**). If one is still idle a few minutes after, `hpipe nudge --task <id>`. Never `rewind` to the same phase for this |
| A worker idle with uncommitted work | `hpipe nudge --task <id>` tells it to commit, push and finish its phase. Never type into its pane |
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
per-pane prompt fan-out, and whether a review subagent perturbs its worker pane's reported status. A
backgrounded subagent keeps the pane reading `working` while the parent's last line is `Waiting for N
background agents to finish`, which herdr's detection manifest has a rule for; once the parent takes
another turn, or leaves a shell or a monitor running, the pane reads `done` (see **Background
work**). Re-run the runbook if you change either.

## License

MIT. See [LICENSE](./LICENSE).
