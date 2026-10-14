# Dispatch — run {{run_id}}

{{dispatch_running}}

Tasks are registered. Your job now is to give each ready task a worktree and an agent, and to keep
two agents off the same files.

**When you are told a task is ready**, dispatch it with one command:

    {{hpipe}} dispatch --ready

Run it with the Bash tool's `run_in_background`, then end your turn. `--ready` takes every task
waiting for its brief, in task id order, and any task that becomes ready before it finishes;
`{{hpipe}} dispatch --task <task_id>` takes one. For each task it fetches the base, creates the
worktree from it, runs the repo's bootstrap in the new checkout, starts the worker with
`--dangerously-skip-permissions` at its tier's effort, and hands it the brief, skipping any step
that is already done. Nothing waits on the shell, so digests keep coming while a bootstrap runs.

When its completion notice arrives, read its step lines. `dispatched tN` means the worker is working
on its brief. `stopped tN at <step>: <why>` means nothing past that step happened: fix what it
names, then run the same command again, and it skips what is already done. Only one dispatch runs in
a repo at a time: a second is refused and names the one under way, so wait for that one's notice
instead of retrying. While one runs, `{{hpipe}} status` says what it is doing for its task rather
than telling you to start an agent.

`{{hpipe}} task` and the `Dispatch tN …` prompt print a `dispatch:` line naming that command, and
under it the same steps as a block, `dispatch, in order:`, with the task's branch, base, agent name
and effort filled in. The block is the manual fallback.

The brief is rendered for that task and carries the bead id, the brief captured at registration, the
surface, the artifact paths the supervisor watches and the task id the worker needs for
`{{hpipe}} decide`. Do not summarise it or send the worker task text of your own: the bead's brief,
captured at registration, is the brief, and anything you say here instead of in it is lost. The copy
you were shown is for you to read; the dispatch sends its own, and claims the task's bead first —
if bd refuses the claim, nothing is sent and the refusal says why. When it came from
`{{hpipe}} task`, the header lines above it — `task_id:`, `tier:`, `effort:`, `bead:` when it filed
one, `files:`, `bootstrap:`, `base:`, `dispatch:` and the `dispatch, in order:` block — are yours:
confirm the `tier:` and `files:` lines match what you declared, then dispatch.
`{{hpipe}} brief --task <id>` prints the bare brief again if you need to reread it, and
`{{hpipe}} show --task <id>` prints what the run recorded for the task — its phase, files,
dependencies, artifact paths, PR and CI — and, while it is unfinished, a freshly fetched `base:`
line to cut a lost worktree from.

{{registering}}

## If you must do it by hand

Run the printed block, which is this sequence with everything filled in:

    herdr worktree create --cwd {{repo_root}} --branch <branch> --base <base>
    # capture .result.root_pane.pane_id and .result.worktree.path from that response
    (cd "<.result.worktree.path>" && ./.claude/pipeline-bootstrap)
    herdr agent start <name> --kind claude --pane <root_pane_id> -- --dangerously-skip-permissions --effort <effort>
    {{hpipe}} dispatch --task <task_id> --pane <root_pane_id>

- **`<base>` is the commit on the `base: <commit> (<ref> as just fetched)` line**, never a base you
  pick: your local `main` is only as new as your last pull. A commit, unlike a remote ref, leaves the
  new branch tracking nothing, so the worker's bare `git push` can never land on the default branch.
  If the line says `fetch failed: …; may be stale`, fix what it names or `git fetch` first.
- **`--cwd` on `worktree create` is not optional.** Without it herdr resolves the repo from the
  focused workspace and creates the worktree in whatever repo that is. `agent start` takes no
  `--cwd`, `--workspace` or `--split`; it adopts the existing root pane and returns once the agent
  is ready for input.
- `<name>` is the agent's name in `herdr agent list`; the printed copy uses the task's bead id.
  The effort follows the tier (light `medium`, standard `high`, heavy `high`): without it the worker
  inherits the user's default, and seven workers at `xhigh` used up a 5-hour usage window in 31
  minutes. Measured on a live run.
- **The bootstrap** is the line `bootstrap:` names, run in the new checkout before `agent start`.
  `bootstrap: none` means there is nothing to run; a script the repo has but never wired up appears
  in the block as an `# optional:` step. A script missing from the new checkout is skipped. Only one
  that exits non-zero is a reason to stop and report; a bare `permission denied` means `chmod +x` it
  in the checkout and run it.
- **Never put the brief on the `agent start` line.** herdr refuses an argument holding fences or
  backticks (`invalid_agent_argument`), and every brief has both. Do not rebuild the handoff out of
  `pane send-text` and `send-keys` either: a pasted brief can sit unsubmitted in the input box.
  `{{hpipe}} dispatch --task <task_id> --pane <root_pane_id>` submits it over `herdr agent prompt`
  and exits zero only once herdr has seen the worker start on it. On a non-zero exit,
  `herdr pane read` the pane before retrying: a retry after a stalled submission sends the brief
  twice.
- **To empty a worker's input box**, `herdr agent send-keys <root_pane_id> ctrl+c` while the worker
  is idle. `ctrl+u` clears only one line, and `esc esc` on an empty box opens Claude's rewind menu.
  Never press `ctrl+c` while the worker is working: it interrupts the turn.
