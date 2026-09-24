# Escalated — run {{run_id}}, phase `{{phase}}`

This phase went {{probes}} stall probes without producing {{awaiting_short}}, and has been open
{{minutes}} minutes. The pipeline has stopped it on purpose.{{undelivered}}

Summarise for the human, in a few lines:

- what this phase was waiting for and what the worker was last doing,
- whether the work in the worktree is salvageable,
- what you recommend.

To resume after they answer:

    {{resume_command}}

which clears every pass counter on that record, not only `{{phase}}`'s, and — when `{{phase}}` is a
review row — reserves a fresh verdict path and prints it. Write the next review there, not to the
previous pass's file.{{abandon}}
