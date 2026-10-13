# Ship — run {{run_id}}: one PR from `{{batch}}` into `{{into}}`

Every task that landed is on `{{batch}}`. It ships as one PR, and CI runs once, on that PR.

1. **Check the combined tree.** This is the one local run of every landing together, and it catches
   what no single task could. Bring the batch checkout up to date:

{{checkout_steps}}

   then, from anywhere in this repo:

       {{hpipe}} batch-check

   {{check_sentence}} This phase clears only once the PR's head is the one it recorded, so run it again
   after any push to `{{batch}}`: a push once the PR has gone on to CI or the merge brings the run back
   here for it. If it is red, dispatch a subagent with `model: {{implement_model}}` to fix it in the
   checkout. If it runs in the background, end your turn and carry on when its completion notice
   arrives; never poll for it or sleep while it runs. Then verify, commit, push, and run `batch-check`
   again.

   If the user wants to check the work themselves before it merges, record it as soon as you know:
   `{{hpipe}} hold --before-merge "<check>"`. The merge waits for their ruling.
2. **Bring `{{into}}` in only if it conflicts.** A PR that conflicts with its base gets no CI, so ask
   git, against `{{into}}` as just fetched:

       {{into_conflict_check}}

   If that reports conflicts, merge `origin/{{into}}` into the batch checkout, resolve, push, and run
   `batch-check` again.
3. **Open the PR, or update it:**

       {{pr_command}}

   The body is the plugin's, at `{{body_path}}`: one release-note line per landing, between
   `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE`. Leave that block alone; a fix that deserves a line
   of its own goes through a fix task, whose title then lands in it. The title only has to pass PR-title
   lint: release-please reads the override block instead.

   The merge step replaces the PR's whole description with `{{body_path}}`, so anything you add to the
   PR on GitHub is dropped. Something worth keeping goes into that file instead, outside the override
   block, and only just before the merge: the plugin rewrites it with every ship prompt.

Once the PR is open at the head `batch-check` recorded, end your turn: the next prompt arrives on its own
when CI has run. Never wait for it with a background shell or monitor polling `{{hpipe}} status` or `gh
pr checks`.

Never force-push, rebase or squash `{{batch}}`: its history is every landing's record.{{ruleset_advice}}
