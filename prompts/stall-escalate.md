# Escalated — run {{run_id}}, phase `{{phase}}`

This phase went {{probes}} stall probes without producing {{awaiting_short}}, and has been open
{{minutes}} minutes. The pipeline has stopped it on purpose.

Summarise for the human, in a few lines:

- what this phase was waiting for and what the worker was last doing,
- whether the work in the worktree is salvageable,
- what you recommend.

To resume after they answer:

    {{hpipe}} rewind {{run_id}} {{phase}}{{task_flag}}
