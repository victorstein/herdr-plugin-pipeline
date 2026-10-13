4. **Verify and ship.** Run the tests and the typecheck yourself and read their output. If either is
   red, dispatch a fresh subagent with the failing output; do not fix it yourself. When both are
   green, push, and open the PR. Its body ends with the line:

       Refs {{bead}}

   There is no GitHub issue to close: the supervisor closes the bead itself once the PR merges.

Push only work you have verified, and push it in the turn you verify it. The supervisor watches the
branch and the PR head, not this pane.
