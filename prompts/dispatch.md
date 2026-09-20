# Dispatch — run {{run_id}}

Tasks are registered. Your job now is to give each ready task a worktree and an agent, and to keep
two agents off the same files.

**When you are told a task is ready**, create its worktree and start the worker on it:

    herdr worktree create --cwd {{repo_root}} --branch <branch> --base main
    # capture .result.root_pane.pane_id from that response
    herdr agent start <name> --kind claude --pane <root_pane_id> -- \
      --dangerously-skip-permissions "<the worker brief you were given>"

**`--cwd` on `worktree create` is not optional.** Without it herdr resolves the repo from the
*focused* workspace, which is usually not yours — the supervisor's own workspace is focused on a cold
start. Omitting it creates the worktree in whatever repo happens to be focused and launches the
worker there, reading `gh issue view` against a different repo's issues. Measured on a live run.

`agent start` adopts the **existing** root pane — it does not create one, and there is no orphan pane
to close. Do not pass `--cwd`, `--workspace` or `--split` **to `agent start`**; they are not in its
0.9.0 signature. That prohibition is about `agent start` only — `worktree create` has `--cwd` and
needs it.

Hand the worker the brief exactly as you were given it. It is rendered for that task and carries the
issue number, the surface, the artifact paths the supervisor watches and the task id the worker needs
for `{{hpipe}} decide`. Do not summarise it, do not add task text of your own: the issue body is the
brief, and anything you say here instead of in the issue is lost. When the brief came from
`{{hpipe}} task`, the three header lines above it — `task_id:`, `files:` and `bootstrap:` — are for
you and not for the worker: confirm the `files:` line matches what you declared, run what
`bootstrap:` names in the new checkout before `agent start`, then hand over everything from the
blank line onward. `{{hpipe}}
brief --task <id>` prints the brief bare, with no header lines and no `files:` echo, so hand that
one over whole — its first blank line falls after the `# <branch> — issue #<n>` heading, and
stripping to it would drop the heading.

**Still registering?** New tasks go in with an issue first, then:

    {{hpipe}} task --branch <branch> --issue <n> --surface <surface> \
               [--depends-on <id,id>] [--files <prefix,prefix>] \
               [--notes "<batch context that does not belong in a public issue>"]

There is no `--text` flag. Never run two agents against the same files in parallel — serialize them
with `--files`, or with `--depends-on` when one needs the other's result.

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
