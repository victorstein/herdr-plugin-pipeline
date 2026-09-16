# Write the implementation plan — {{branch}} (#{{issue}})

The spec at `{{spec_path}}` cleared review. Turn it into an implementation plan.

Write it to exactly this path:

    {{plan_path}}

Bite-sized steps, two to five minutes each, TDD throughout: write the failing test, run it, implement
the minimum, run it again, commit. Exact file paths. Complete code in every step — no placeholders,
no "similar to step N", no "add appropriate error handling". Every step leaves the tree working and
committable.

Assume the implementer has no context for this codebase beyond `{{spec_path}}` and this plan. You are
that implementer, several phases from now, with your reasoning gone.

If you are back here from a `BLOCKER` verdict (pass {{pass}}), the review is the newest file for this
issue under `docs/superpowers/reviews/`. Fix every BLOCKER and every MAJOR you accept before
rewriting anything else.

Commit and push the plan, then stop.
