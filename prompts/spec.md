# Write the spec — run {{run_id}}

Write the spec for **{{title}}** now. Do not ask whether to proceed.

If a design conversation already happened, this spec records what was agreed. If one did not — the
run can be started without it — do not manufacture agreement. Write each behavioural decision down as
an explicit, labelled assumption so the review that follows can challenge it, rather than burying the
choice in prose.

Write it to exactly this path:

    {{spec_path}}

Cover: problem, goal, non-goals, architecture, the data and control flow, error handling, and a
testing strategy. Cite `file:line` for every claim about how this repo already works — verify against
the code, do not assert from memory.

Follow the repo's prime directive: mirror the nearest existing example and name the file you modelled
on. If neither this repo nor the gold standard establishes a pattern the work needs, stop and say so
rather than inventing one.

When the file exists and is complete, stop. The next step is dispatched automatically.
