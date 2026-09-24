# Escalation — run {{run_id}}, phase `{{phase}}`

This phase hit {{pass}} review passes without clearing. The pipeline has stopped here on purpose.

Do not start another pass. Summarise for the human, in a few lines:

- what the reviews keep finding,
- which decision or tradeoff is actually in dispute,
- the options, with your recommendation.

This is one of the only two reasons to interrupt them, so make it worth the interruption.

When they have answered, resume with:

    {{resume_command}}

which clears every pass counter on that record, not only `{{phase}}`'s, and — when `{{phase}}` is a
review row — reserves a fresh verdict path and prints it. Write the next review there, not to the
previous pass's file.
