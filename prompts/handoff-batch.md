4. **Verify and submit.** Run the tests and the typecheck yourself and read their output. If either is
   red, dispatch a fresh subagent with the failing output; do not fix it yourself. When both are
   green, push, and submit:

       {{hpipe}} submit --task {{task_id}} --title "<conventional title>"

   The title is this change's line in the release notes of the one PR `{{batch}}` ships as:
   `<type>(<scope>): <summary>`, on one line, with a type this repo's release notes read. {{check_note}}
   `submit` refuses work that is uncommitted, unpushed, already on `{{batch}}`, or titled with a type
   the notes drop, and says why; fix what it names and run it again.

   Never open a PR from this branch. It was cut from `{{batch}}`, so a PR into `{{into}}` would carry
   every sibling's commits with it.

Push only work you have verified, and submit it in the turn you verify it. The supervisor watches
what you submit, not this pane.
