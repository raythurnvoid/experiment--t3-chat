# Proof Gaps

Extends the break-first rule in the verification standard. That rule — remove
the fix, watch the test fail — is the floor. These are the ways a test still
fails to prove anything with the rule followed.

## Read How It Fails, Not Just That It Fails

When you disable the code and the test goes red, check *why* it went red. If it
failed on a fixture error, a missing membership, or a rate limit rather than on
the assertion you care about, the test was never exercising the code. It was
failing early for an unrelated reason and passing for an unrelated reason too.

## Every Refusal Test Needs A Positive Control

A test that only asserts something is refused passes just as well against code
that refuses *everyone*. Over-strict code is a real and common bug, and a
refusal-only test is blind to it by construction.

Watch for a control arm that bypasses the code under test. If the "allowed" case
is an owner, an admin, or a superuser who short-circuits the check higher up,
the test proves a refusal happened but never that it **depended on the caller**.
Pick a control that goes through the same path and is allowed on its merits.

This trap is easy to miss because the test reads correctly and passes.

## Assert The Side Effect, Not Just The Return

A mutation can refuse and still commit. A test that checks only the error
message passes in both cases. Re-read the stored state — database, file, queue,
wherever the write lands — and assert that the write did not happen.

## Ways Tests Pass For The Wrong Reason

- **Wrong fixture.** Setup never created the state the test names.
- **Earlier throw.** Something fails before the assertion and the error matches.
- **Tautology.** The expected value is derived from the same source the code
  used, so it cannot disagree.
- **Stale copy.** The test hardcodes a duplicate of a constant. When the real one
  changes, the test asserts history. Derive from the source of truth instead of
  restating it — a hand-copied list is a test that will go wrong later.
- **Deleted-code check.** Delete the code under test and re-run. Still passing
  catches a wrong fixture or an earlier throw; a tautology or stale copy goes
  red for the wrong reason instead — so read why it failed, not just that it did.

## Mutating Safely

Keep the mutation local, revert it immediately, and never do it in a tree other
agents are reading — a stray experimental edit read by another agent becomes a
confident finding about code that was never written.
