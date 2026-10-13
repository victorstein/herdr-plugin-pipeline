# The human's check failed — {{branch}} ({{bead}}), PR #{{pr}}

The human checked PR #{{pr}} at {{failed_head}} before letting it merge, and the check failed. The PR
is not merged, and this task is back in `implement`.

**The check{{failed_from}}:** {{failed_check}}

**What they saw:** {{failed_seen}}

This is your PR to fix. Work out what made the check fail before deciding what to change: what they
saw is the evidence, and the check is what the fix must make true.

You keep the judgment and one subagent writes the fix. Dispatch it with `model: {{implement_model}}`; if
the dispatch is rejected for its model, dispatch without `model:` and say so in the PR. Its brief is
what the human saw, the check, what you concluded about the cause, and the implementer's brief below,
verbatim. If it runs in the background, end your turn and carry on when its completion notice arrives;
never poll for it or sleep while it runs. If it returns a question, raise it with `{{hpipe}} decide` as
your brief describes, and end your turn without pushing: its partial work is unverified, and the answer
resumes it.

When it returns, run the tests and the typecheck yourself and read their output. If either is red,
dispatch a fresh subagent with the failing output; do not fix it yourself. When both are green, say in
the PR body how the human can check it again, and push. Push only work you have verified. The fix goes
through review and CI again, and the human checks the new head before it merges.

## The implementer's brief

Read `{{agent_file}}` before your first edit: it is the scoped guide for this surface, and the repo's
root `CLAUDE.md` outranks it where they conflict. Work only in this worktree, only on `{{branch}}`.
Never commit to or push the default branch.

Re-read every file you are about to touch before you edit it. A sibling task may have landed changes
on the same files while this one waited; code written against the old text will conflict, or will
quietly undo work that has already merged. Where the tree has moved under what you were given,
follow the tree and say so in your report.{{shared_note}}

Work step by step, in order: the failing test first, run it, the minimum code that passes it, run it
again, commit. One commit per step, with a conventional-commit message. Do not batch steps, and do
not skip a step's test because the change looks obvious. Commit, but do not push: pushing is the
worker's, once it has verified your work. If the plan has a step that pushes, opens a PR or runs
`{{hpipe}} submit`, skip it and say so in your report.

You cannot ask for decisions. On a choice you should not make alone — expensive to undo, changes
scope, commits another surface to a contract, or invents a pattern this repo does not already
establish — stop and return the question, with your recommendation, instead of choosing. End your
report with which steps you finished and which you did not.
