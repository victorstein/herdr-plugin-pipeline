# CI is red on the batch PR — run {{run_id}}, PR #{{pr}}

CI failed on PR #{{pr}} (`{{batch}}` into `{{into}}`). The failing checks:

{{ci_failure}}

Read the actual failure output before deciding what is wrong — `gh run view --log-failed` — rather
than guessing from the check name. Then take the first route that fits:

1. **Environmental.** Push an empty commit to `{{batch}}` from its checkout:
   `git -C {{checkout_quoted}} commit --allow-empty -m "ci: re-run <check>" && git -C {{checkout_quoted}} push`.
   A `gh run rerun` moves no head, and this phase waits on the head.
2. **A small defect — the default.** A few lines, in files the failure names, adding no behaviour the
   release notes would mention. Bring the checkout up to date:

{{checkout_steps}}

   then dispatch one subagent with `model: {{implement_model}}` to fix it there, and **wait for it
   within this turn**. Verify it, commit, push, then run `{{hpipe}} batch-check`: the PR clears only on
   a head that passed it.
3. **A bigger defect, or one that is itself a user-visible change.** Register a fix task into this
   run — `{{hpipe}} task …` as at intake, which moves the run back to `execute` — then
   `{{hpipe}} dispatch --done`. It is cut from `{{batch}}`, reviewed, synced and landed like any task,
   and its title joins the release notes. The run then goes `execute → branch-review → ship`.

This is pass {{pass}} of {{max_passes}}: the batch PR gets one repair, by patch or by fix task, and a
second red escalates the run to the human. Registering a fix task does not reset that.
