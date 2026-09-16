# Write the spec — {{branch}} (#{{issue}})

Write the spec for issue #{{issue}} now. Do not ask whether to proceed.

Write it to exactly this path:

    {{spec_path}}

Cover: problem, goal, non-goals, architecture, the data and control flow, error handling, and the
testing strategy. Build on your research note at `{{research_path}}` and cite `file:line` for every
claim about how this repo already works — verify against the code, never from memory.

Every behavioural decision goes down as an explicit, labelled assumption, so the review that follows
can attack it. A choice buried in prose is a choice nobody reviews.

Mirror the nearest existing example and name the file you modelled on. If neither this repo nor its
gold standard establishes a pattern this work needs, do not invent one — `{{hpipe}} decide` with your
recommendation.

If you are back here from a `BLOCKER` verdict (pass {{pass}}), the review is the newest file for this
issue under `docs/superpowers/reviews/`. Fix every BLOCKER and every MAJOR you accept, and record in
the spec what changed and why — a half-applied fix is the highest-value finding the next pass has.

Commit and push the spec, then stop.
