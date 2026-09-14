# Live smoke test

Manual, ~5 minutes. Uses a throwaway session so it cannot disturb `default` or `personal`.

## Setup

```bash
export SMOKE=pipesmoke
herdr plugin link "$PWD"   # link BEFORE the session first boots — see below
herdr plugin list          # assert: stein.pipeline present, warnings empty
herdr --session "$SMOKE" server &
sleep 2
```

> **Order matters.** `plugin link` registers the plugin but does **not** run its
> startup hook against a server that is already running — verified live, including
> after `server reload-config`. Link first, or restart the session afterwards.
> Otherwise reconciliation never runs and assertion 1 finds an empty workspace list.

## Assertions

1. **Startup reconciliation ran.**
   ```bash
   herdr --session "$SMOKE" workspace list   # assert: a workspace labelled "pipeline"
   herdr --session "$SMOKE" pane list        # assert: exactly ONE "Pipeline supervisor" pane
   ```

2. **The supervisor is live and knows it.**
   ```bash
   hpipe status              # assert: "supervisor: live"
   ```

3. **Hooks enqueue on a real worktree event.**
   ```bash
   herdr --session "$SMOKE" worktree create --branch smoke/x --base main
   # assert: a file appeared under $HERDR_PLUGIN_STATE_DIR/queue/ within a second,
   # then vanished as the supervisor drained it.
   ```

4. **`agent start` adopts the root pane.** Capture `.result.root_pane.pane_id` from the
   `worktree create` response above, then:
   ```bash
   herdr --session "$SMOKE" agent start smoke --kind claude --pane <root_pane_id>
   ```
   assert: `pane list` for that workspace shows exactly ONE pane both before and after. There is no
   orphan to close — that is the whole point of this assertion.

   Start the agent with no trailing `-- --version`: a command that exits immediately finishes before
   herdr's interactive-readiness detection fires, so `agent start` reports `timeout` even though pane
   adoption worked correctly. Judge this assertion on the pane count, and quit the agent afterwards.

5. **No plugin commands were dropped.**
   ```bash
   herdr plugin log list --plugin stein.pipeline | grep -c plugin_command_limit_reached
   ```
   assert: `0`. This is the assertion that would catch a regression back into blocking hooks.

6. **A dead supervisor leaves a readable pane.**
   ```bash
   kill $(jq -r .pid "$HERDR_PLUGIN_STATE_DIR/supervisor.$SMOKE.pid")
   herdr --session "$SMOKE" pane read <supervisor_pane_id> --source visible --lines 5
   ```
   assert: contains "supervisor exited", and the pane still exists.

## Teardown — mandatory

```bash
herdr plugin unlink stein.pipeline
herdr --session "$SMOKE" worktree remove --workspace <ws> --force
herdr --session "$SMOKE" server stop
herdr session delete "$SMOKE"
rm -f ~/.local/bin/hpipe
herdr plugin list          # assert: back to empty
herdr session list         # assert: only the sessions that were there before
```
