# ADR-0010: Work session lifecycle and current-stage escalation

Status: Accepted

## Context

Phase 5 scale measurement found that evaluating a repeating deadline materialized one alert effect
per elapsed repeat interval, without bound. A single unacknowledged item produced 2,017 effects
after a week and 8,641 after a month, each becoming a delivery per enabled transport and each sent
by the dispatcher. Reopening the page after an absence would have produced an alert storm, and an
item left unacknowledged accrued rows every five minutes even while the app ran normally. A
scheduler pass over a 2.8-hour window of a thousand items took 85 seconds against a scheduler that
fires every 15 seconds.

The underlying question was not a threshold but a scope: what span does the attention queue belong
to? AckWatch monitors for a working session. It is not a long-term tracker, and it was never
specified as one, but nothing in the model bounded the data to a session.

## Decision

Introduce a **work session** as a first-class concept, distinct from a monitoring session.
Monitoring is armed and disarmed many times and never survives a reload; one work session spans
those and holds the acknowledgements being worked through.

- Exactly one work session is open per account. Starting monitoring with none open opens one.
- Ending a session produces a redacted summary — counts and timings only, no previews, room IDs,
  event IDs, or senders — and only then clears the session's work. The export always precedes the
  delete, so nothing is discarded without a record.
- Ending a session does not clear account configuration. Settings are the user's setup, not session
  output; wiping a webhook endpoint on every session end would be hostile.
- On startup an open session is judged by its age against a configurable continuity window,
  defaulting to 12 hours and measured from the session's start time. Older is retired automatically
  and the user is told. Newer is offered back as an interrupted session to continue or replace,
  because a reload or crash mid-session must not cost the user their acknowledgements.
- While a session is interrupted and unadopted, no alert dispatches: what to alert on has not been
  decided yet.
- Neither resuming nor retiring a session arms monitoring. Monitoring always comes up off.

Independently, deadline evaluation materializes at most the stage that is currently due. Stages
that elapsed unobserved are not replayed.

## Consequences

Alert volume after an absence is bounded by the number of items, not by the time away, and the
effect table is bounded by session length rather than growing forever. The scheduler pass fell from
84,850 ms to 5,896 ms at a thousand items.

The cost is that escalations genuinely missed while the page was closed are not delivered late.
That is a restatement of an existing guarantee rather than a new limitation: ADR-0009 already holds
that audio, browser notifications, and webhooks operate only while the page is able to run.

Measuring window age from session start, rather than from last observed activity, means a session
open longer than the window is retired on the next reload even if the user never left. The window
is configurable so a long working day can raise it. This was a deliberate choice; the alternative,
a liveness heartbeat, remains available if the behavior proves annoying in use.

Two specification requirements are amended rather than silently redefined: DDL-007 records the
current-stage rule, and DB-008 scopes completed-history retention to the session that produced it.
