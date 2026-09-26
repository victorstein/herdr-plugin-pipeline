# CI is red — {{branch}} (#{{issue}}), PR #{{pr}}

CI failed on PR #{{pr}}. The failing checks:

{{ci_failure}}

This is your PR to fix. Read the actual failure output before deciding what is wrong —
`gh run view --log-failed` — rather than guessing from the check name.

If the failure is environmental rather than a defect in this branch, say so in the PR and re-run the
check instead of editing code.

If it is a defect, you keep the judgment and one subagent writes the fix. Dispatch it with
`model: {{implement_model}}`, and **wait for it within this turn**: a backgrounded subagent leaves this
pane reading idle while the fix is still being written. Its brief is the failing output, what you
concluded from the log, and the implementer's brief below, verbatim. If it returns a question, raise
it with `{{hpipe}} decide` and end your turn. If the dispatch is rejected for its model, dispatch
without `model:` and say so in the PR.

When it returns, run the tests and the typecheck yourself, read their output, and push. The
supervisor watches the PR head, not this pane.

## The implementer's brief

Read `{{agent_file}}` before your first edit: it is the scoped guide for this surface, and the repo's
root `CLAUDE.md` outranks it where they conflict. Work only in this worktree, only on `{{branch}}`.
Never commit to or push the default branch.

Re-read every file you are about to touch before you edit it. A sibling task may have landed changes
on the same files while this one waited; code written against the old text will conflict, or will
quietly undo work that has already merged. Where the tree has moved under what you were given,
follow the tree and say so in your report.

Work step by step, in order: the failing test first, run it, the minimum code that passes it, run it
again, commit. One commit per step. Do not batch steps, and do not skip a step's test because the
change looks obvious. Commit, but do not push: pushing is the worker's, once it has verified your
work.

You cannot ask for decisions. On a choice you should not make alone — expensive to undo, changes
scope, commits another surface to a contract, or invents a pattern this repo does not already
establish — stop and return the question, with your recommendation, instead of choosing. End your
report with which steps you finished and which you did not.
