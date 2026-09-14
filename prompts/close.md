# Verify the issue closed — {{branch}} (#{{issue}}), PR #{{pr}}

PR #{{pr}} is merged. Confirm issue #{{issue}} actually closed:

    gh issue view {{issue}} --json closed,state

If it is still open, the PR body used a phrase GitHub does not treat as a closing keyword. Close it
by hand and note which phrasing failed, so the task prompt can be corrected.

Teardown of the worktree runs automatically once closure is confirmed.
