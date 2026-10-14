# Stop — run {{run_id}} was aborted ({{task_id}}, {{branch}})

The orchestrator aborted run {{run_id}}, so the pipeline no longer drives `{{task_id}}` in
`{{phase}}`. Stop now. Let the tool call you are in finish, then start nothing new: no commits, no
pushes, no PRs, and no `{{hpipe}}` command for this task, which is refused until the run is resumed.
Stop any subagent or background command you started, if you can.

Leave your checkout as it is, uncommitted work included: nothing deletes it. If the run is resumed
you will be told to carry on. Until then, end your turn.
