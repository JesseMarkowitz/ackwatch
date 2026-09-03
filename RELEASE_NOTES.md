# Release notes

## Unreleased — V1 release candidate

AckWatch is a local-first attention monitor for Matrix. It watches the rooms you supervise during a
working session, turns activity that needs a response into a queue item, and keeps that item visible
until you acknowledge and complete it. Everything it knows lives in your browser: there is no
AckWatch server, no account, and no telemetry.

### What V1 does

- **Monitoring with an honest boundary.** Monitoring starts only when you arm it and the network has
  confirmed the client is live. It never auto-resumes after a reload. Coverage is reported as
  independent dimensions — connection, armed state, audio, notification permission, webhook health —
  because collapsing them into one green light would hide a gap.
- **A durable attention workflow.** Items carry status, deadlines, thread merge, reopening, and
  completion, stored transactionally in IndexedDB and restored intact across reloads and crashes.
- **End-to-end encryption.** A persistent device with cross-signing, secret storage, key backup, and
  emoji device verification. Undecryptable events appear as placeholders rather than being dropped.
- **Alerts.** Bundled audio, browser notifications, and an optional generic or ntfy-compatible
  webhook, with bounded escalation and a durable record of delivery intent.
- **Work sessions.** A session holds the queue you are working through. Returning within the
  continuity window (12 hours by default, configurable) offers the interrupted session back with
  your acknowledgements intact; an older one is archived to a redacted summary and replaced. Ending
  a session archives it the same way and clears its work, leaving your configuration alone.
- **Your data, inspectable.** Storage status, export, and clear are in the app, and the diagnostics
  export carries counts, codes, and timings only — no previews, room or event IDs, senders, webhook
  endpoints, or topics.

### Limitations, stated plainly

These are properties of the product, not defects awaiting a fix.

- **A closed page monitors nothing.** AckWatch runs entirely in the browser tab. When the tab is
  closed, monitoring, alerting, and delivery all stop. Nothing about the product should be read as a
  claim that it watches your rooms while you are away, and it is never represented as doing so.
- **Browser notifications are supplemental.** They require permission you grant per origin, they are
  subject to the operating system's own do-not-disturb and focus rules, and they do not work after
  the page closes. AckWatch guarantees durable _intent_ to alert — a record that an alert was owed
  and dispatched — not exactly-once delivery to your desktop. Audio has the same character: a muted
  tab or a device with no output produces no sound, and the health indicator says so rather than
  pretending otherwise.
- **Webhook payloads are deliberately uninformative.** They carry a stable ID and a generic
  notification, never room labels, senders, previews, attachment names, Matrix URIs, or tokens. If
  you want to know _what_ needs attention, you open AckWatch. This is not configurable, because a
  webhook leaves the machine.
- **Supported browsers are current desktop Chromium and Firefox.** Those are the engines the
  qualification suite runs against. WebKit is exercised advisory-only through Playwright, which
  **is not real Safari** — it is a different build with different behaviour, and passing there is
  not evidence that AckWatch works in Safari. Safari is not a supported browser in V1.
- **The Content Security Policy is a template you complete.** AckWatch ships the strict policy it
  actually runs under, with `connect-src` left for the deployer to fill in with their homeserver and
  webhook origins. Those origins are not known at build time, and widening the directive to `https:`
  to avoid the step would let the page talk to any host. See [Deployment](./docs/DEPLOYMENT.md).
- **A session is retired by the clock, not by your activity.** The continuity window is measured
  from when the session started, so a session left open longer than the window is retired on the
  next reload even if you never stepped away. This was chosen over measuring from last activity so
  that "how long has this session been running" has one answer.
- **Sign-in is session-only.** Passwords are never retained. Signing in again after the session ends
  is expected, not a bug.
- **The homeserver must send permissive CORS headers** for the client-server API. Synapse does by
  default; a reverse proxy that strips them makes sign-in fail with a network error.

### Performance

Measured against a real IndexedDB in Chromium via `npm run test:scale`. At a realistic session size
(2,000 activities / 200 items) every target is met. At the plan's stress ceiling (10,000 / 1,000)
command latency and the scheduler pass stay within target and per-ingested-event cost runs about
64 ms against a 50 ms target — accepted for V1, since closing it would mean incremental item
maintenance whose failure mode is stale or duplicated items after a thread merge, a correctness risk
not worth taking for a cost that appears only at five times realistic load.

### Attribution

AckWatch is an independent open-source project. It is not endorsed by The Matrix.org Foundation or
by Element. Apache License 2.0.
