# Decompose and dispatch — run {{run_id}}

The plan at `{{plan_path}}` cleared review. Turn it into tasks and dispatch them.

For each task:

1. **Open a GitHub issue** — one per task, no exceptions: `gh issue create`.
2. **Register it:**

       hpipe task --branch <branch> --issue <n> --surface <surface> \
                  [--depends-on <task_ids>] [--files <path-prefixes>] \
                  --text "<the full task text>"

   `--surface` routes the worker to `.claude/agents/<surface>-dev.md` and is rejected if no such file
   exists. Route by the surface the change touches, and make app tasks `--depends-on` any `core` task,
   because the apps consume the built `dist`.

   `hpipe task` prints the task id. If the task is gated it prints `queued: waiting on …` instead of a
   prompt — that is correct; you will be told when to dispatch it.

3. **When told a task is ready**, create its worktree and start the agent:

       herdr worktree create --branch <branch> --base main
       # capture .result.root_pane.pane_id from that response
       herdr agent start <name> --kind claude --pane <root_pane_id> -- \
         --dangerously-skip-permissions "<the worker prompt you were given>"

   `agent start` adopts the **existing** root pane — it does not create one, and there is no orphan
   pane to close. Do not pass `--cwd`, `--workspace`, or `--split`; they are not the 0.9.0 signature.

Never run two agents against the same files in parallel. When two tasks must touch one file,
serialize them with `--depends-on`.

Register every task, then stop.
