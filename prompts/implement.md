# Implement — {{branch}} (#{{issue}})

The plan at `{{plan_path}}` {{plan_status}}. The files you need are yours.

You keep the judgment; one subagent writes the code. Do not write it yourself.

1. **Triage.** If you are here from a `BLOCKER` verdict (pass {{pass}}), the review is the newest file
   for this issue under `docs/superpowers/reviews/`. Decide which findings you accept. Every BLOCKER
   and every MAJOR you accept goes to the subagent before anything else; answer the ones you reject
   in the PR body rather than silently ignoring them.
2. **Dispatch.** Dispatch one subagent with `model: {{implement_model}}`, and
   **wait for it within this turn**. Backgrounding it ends your turn and leaves this pane reading
   idle while the code is still being written, and the supervisor then treats a healthy worker as a
   stalled one. Its brief is the plan path, `{{plan_path}}`; the findings you accepted, if any; and
   the implementer's brief below, verbatim.
3. **Continue.** If the subagent returns with steps unfinished, dispatch a fresh one, starting at the
   first unfinished step. If it returns a question, raise it with `{{hpipe}} decide` as your brief
   describes, and end your turn.
4. **Verify and ship.** Run the tests and the typecheck yourself and read their output. When both are
   green, push, and open the PR. Its body ends with a real closing keyword:

       Closes #{{issue}}

   "Implements #{{issue}}" does **not** auto-close the issue and is treated as a failure.
5. **Fallback.** If the dispatch is rejected for its model, dispatch without `model:` and say so in
   the PR body.

Push before your turn ends. The supervisor watches the branch and the PR head, not this pane.

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
