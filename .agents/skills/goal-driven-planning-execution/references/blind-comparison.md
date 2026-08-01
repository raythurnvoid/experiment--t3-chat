# Blind Comparison

How to turn "make it beautiful" into an objective that can fail.

Self-assessment of quality is worthless: the agent that built the thing will
report that the thing is good. Numbers do not work either, because the property
in question is a judgement. Comparison is what works, and it has to be blind,
because a critic told which artifact is yours will find reasons to prefer it.

First convert everything you can into falsifiable claims; run this protocol
only for the residue that stays a judgement — visuals, copy, feel. Residue
must come from the bar itself: a quality the bar names that no claim captures.
A generic bar word alone ("great", "production quality") does not create
residue; converting everything and finding none is a normal outcome. If nothing
stays subjective, skip it. Skip too when no comparator artifact could exist for
the residue — not merely when none was given — and then restate the residue as
the closest falsifiable claims, saying so. When a comparator could exist, pick
one (step 1) rather than skip.

For the visual case, use whatever image-capable model or visual-verifier
skill the environment provides. A labeled two-image comparison (reference vs
current) is the right tool for extracting the differences in step 6. The
preference judgement in step 3 stays blind regardless of tooling — send both
images as A and B to a fresh image-capable subagent per judgement, or,
without image-capable subagents, as a plain image-model chat ask in a new
chat per judgement; a text answer is fine. With no image-capable critic of
any kind, step 4's fallback applies. Never run the preference judgement
through a labeled comparison template, and never say "ours" or "reference".

The judgement's medium is the form the user consumes — pixels for anything
judged by its rendered look. Rendered text (terminal output, markdown) sits
between media: prefer an image of the rendered form; when no such image can
be produced or judged, a fresh text critic judging the raw output is the
fallback — say which form was judged.

## Protocol

1. **Fix the reference before building.** A competitor screen, a design mock, a
   screenshot of the product being imitated. Get the user to accept it as the
   bar at kickoff, while they are present — do not pause a running loop to ask.
   When the bar arrives together with an autonomy instruction, ask once in the
   kickoff reply and go provisional if building starts before an answer. If the
   loop is already autonomous with no accepted reference, pick the most
   defensible one, mark the bar provisional, and say so in the report. Keep the
   reference unchanged across rounds — a moving reference makes improvement
   unmeasurable.
2. **Match the framing.** Same viewport, same zoom, same state, same content.
   A comparison that differs in framing measures the framing. Against a real
   competitor, match what can be matched and name what could not be.
3. **Present under neutral names, in randomised order.** Call them A and B;
   never say which is yours. Recognition you cannot always prevent; bias from
   labels you can. Ask only: which is better — or too close to call — and what
   specific differences decided it.
4. **Use a critic that did not build it.** A fresh agent with no history of the
   work, and no access to the conversation that produced it — a subagent, or an
   image model that never saw the build. Only when no stake-free critic
   capable of the judgement's medium exists, report that the preference
   judgement could not run — do not judge your own work instead. The rest of
   the protocol still applies: keep the reference, match framing, and extract
   differences (step 6) to drive the work; the objective just cannot be
   marked met without the judgement.
5. **Run at least three judgements, an odd number, each from a fresh critic.**
   A single judgement is noisy, and one critic asked repeatedly repeats its
   first answer — correlated votes are one vote. An odd count keeps the tally
   below from tying. Disagreement across runs is itself information: it means
   the two are close.
6. **Turn the differences into the next round's work list.** "Prefers the
   reference" is not actionable; "the reference has tighter line-height and a
   real empty state" is.

Score each run as *reference* or *not the reference* — a too-close run counts
as not the reference, because the bar is a critic who prefers ours or cannot
separate them. With an odd count, one side always has most. When a single vote
decides the tally, extend it once — run two more judgements — before calling
it; the extended tally stands even at a one-vote margin. Done on that
objective when most runs score not the reference. Most runs for the reference
is not done — turn the cited differences into the work list.

## Beyond Visuals

The same protocol generalises to any bar the user states as a comparison:

- **API ergonomics** — give two agents the same task against the two APIs
  unlabelled, and see which one they complete more cleanly.
- **Copy and docs** — hand both to a reader who does not know the product and
  ask which explains it better.
- **Error messages** — show the message alone and ask what the reader would do
  next.

The invariant is always the same: a judge with no stake, no labels, and a fixed
reference.
