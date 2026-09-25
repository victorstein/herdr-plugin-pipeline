# Dispatch — run {{run_id}}

Tasks are registered. Your job now is to give each ready task a worktree and an agent, and to keep
two agents off the same files.

**When you are told a task is ready**, create its worktree, start the worker on it bare, then hand
it the brief:

    herdr worktree create --cwd {{repo_root}} --branch <branch> --base <base>
    # capture .result.root_pane.pane_id and .result.worktree.path from that response
    herdr agent start <name> --kind claude --pane <root_pane_id> -- --dangerously-skip-permissions
    {{hpipe}} dispatch --task <task_id> --pane <root_pane_id>

**`<base>` is the one the `Dispatch tN … --base <base>` line names** — usually `origin/main` — not
one you pick. The supervisor fetched it just before telling you the task is ready; your
local `main` is only as new as your last pull, and a task cut from it lacks whatever its
dependencies merged since. Measured on a live run.

**Never put the brief on the `agent start` line.** herdr refuses to encode an argument holding fences
or backticks for the target shell (`invalid_agent_argument`), and every brief has both, so it fails
for every task. Do not rebuild the handoff out of `pane send-text` and `send-keys` either: a pasted
brief can sit unsubmitted in the input box, and nothing tells you. Measured on a live run.
`{{hpipe}} dispatch --task` renders the brief itself, submits it over `herdr agent prompt`, and exits
zero only once herdr has seen the worker start working on it. On a non-zero exit, `herdr pane read`
the pane before retrying — a retry after a stalled submission sends the brief twice.

**To empty a worker's input box** — a brief that sat unsubmitted, a stray word — use
`herdr agent send-keys <root_pane_id> ctrl+c` while the worker is idle. It clears the whole box,
however many lines. `ctrl+u` clears only the line the cursor is on, `C-u` is not a key name herdr
accepts, and `esc esc` on an empty box opens Claude's rewind menu. Never press `ctrl+c` while the
worker is working: it interrupts the turn. Measured on a live run.

**`--cwd` on `worktree create` is not optional.** Without it herdr resolves the repo from the
*focused* workspace, which is usually not yours — the supervisor's own workspace is focused on a cold
start. Omitting it creates the worktree in whatever repo happens to be focused and launches the
worker there, reading `gh issue view` against a different repo's issues. Measured on a live run.

`agent start` adopts the **existing** root pane — it does not create one, and there is no orphan pane
to close. It returns once the agent is ready for input, which is when the handoff can go. Do not pass
`--cwd`, `--workspace` or `--split` **to `agent start`**; they are not in its 0.9.0 signature. That
prohibition is about `agent start` only — `worktree create` has `--cwd` and needs it.

The brief is rendered for that task and carries the issue number, the surface, the artifact paths the
supervisor watches and the task id the worker needs for `{{hpipe}} decide`. Do not summarise it or
send the worker task text of your own: the issue body is the brief, and anything you say here instead
of in the issue is lost. The copy you were shown is for you to read; `dispatch --task` sends its
own. When it came from `{{hpipe}} task`, the three header lines above it — `task_id:`, `files:` and
`bootstrap:` — are yours: confirm the `files:` line matches what you declared, and run what
`bootstrap:` names in the new checkout before `agent start`. `{{hpipe}} brief --task <id>` prints
the bare brief again if you need to reread it, and `{{hpipe}} show --task <id>` prints what the run
recorded for the task — its phase, files, dependencies, artifact paths, PR and CI.

**Still registering?** Every new task is backed by an issue — file it with `gh issue create`, then:

    {{hpipe}} task --branch <branch> --issue <n> --surface <surface> \
               [--depends-on <id,id>] [--files <prefix,prefix>] \
               [--notes "<batch context that does not belong in a public issue>"]

or let `--title "<title>" --body-file <path>` in place of `--issue <n>` file it with that body and
register it in one step. There is no `--text` flag: whatever the worker needs goes in the issue body.
Never run two agents against the same files in parallel — serialize them with `--files`, or with
`--depends-on` when one needs the other's result.

**When the last task is registered:**

    {{hpipe}} dispatch --done

Nothing infers that the batch is complete, and the run cannot finish until you say so.

## Bootstrapping the new checkout

A fresh worktree is a bare `git` checkout: no `node_modules`, no `.venv`, no submodules, no built
`dist`. If the repo declares a bootstrap, the `bootstrap:` header line names it, and you run it in
the NEW checkout after `worktree create` and before `agent start`. The create response carries the
path as `.result.worktree.path`:

    (cd "<.result.worktree.path>" && ./.claude/pipeline-bootstrap)

`bootstrap: none` means the repo declares nothing; start the worker.

If the script is **not present in the new checkout**, skip it and start the worker — the line is
read from the primary checkout's working tree, which can be parked on a branch the worktree was not
cut from, so its absence there is not a failure. Only a script that exists and **exits non-zero** is
a reason to stop and report instead of starting the worker: that one hands the worker a broken build
it will not discover until `implement`. The one exception is a bare `permission denied`, which means
the checkout's copy is not executable rather than broken — `chmod +x` it in the new checkout, run it,
and carry on.
