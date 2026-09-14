# Escalation — run {{run_id}}, phase `{{phase}}`

This phase hit {{pass}} review passes without clearing. The pipeline has stopped here on purpose.

Do not start another pass. Summarise for the human, in a few lines:

- what the reviews keep finding,
- which decision or tradeoff is actually in dispute,
- the options, with your recommendation.

This is one of the only two reasons to interrupt them, so make it worth the interruption.

When they have answered, resume with:

    hpipe rewind {{run_id}} {{phase}}{{task_flag}}

which resets the pass count for that phase.
