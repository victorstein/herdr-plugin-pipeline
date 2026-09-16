# Implement — {{branch}} (#{{issue}})

The plan at `{{plan_path}}` cleared review and the files you need are yours. Build it.

**Re-read every file you are about to touch before you edit it.** You may have waited here while a
sibling task landed changes on the same files; a plan written against the old text will conflict, or
will quietly undo work that has already merged. Where the tree has moved under the plan, follow the
tree and say so in the PR.

Work the plan step by step, in order: the failing test first, run it, the minimum code that passes
it, run it again, commit. Do not batch steps, and do not skip a step's test because the change looks
obvious.

If you are here from a `BLOCKER` verdict (pass {{pass}}), the review is the newest file for this issue
under `docs/superpowers/reviews/`. Fix every BLOCKER and every MAJOR you accept before touching
anything else, and answer the ones you reject in the PR rather than silently ignoring them.

When the work is green — tests and typecheck, both run, both read from their own output — open the
PR. Its body ends with a real closing keyword:

    Closes #{{issue}}

"Implements #{{issue}}" does **not** auto-close the issue and is treated as a failure.

Push before your turn ends. The supervisor watches the branch and the PR head, not this pane.
