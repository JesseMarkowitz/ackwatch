# AckWatch

AckWatch is a local-first attention monitor for Matrix. It is an independent open-source
project and is not endorsed by The Matrix.org Foundation or Element.

The application is at the Phase 4 reliability-beta gate. It supports session-only password login,
exclusive account ownership, a network-confirmed monitoring boundary, serial event intake, and a
durable attention workflow with thread merge, deadlines, settings transfer, storage health, and
reload restoration. Phase 4 adds end-to-end encryption with a persistent device — cross-signing,
secret storage, key backup, and emoji device verification — the complete V1 event table, and
durable alert delivery through bundled audio, browser notifications, and an optional generic or
ntfy-compatible webhook. Monitoring still returns off after every reload.

AckWatch monitors for a working session rather than tracking indefinitely. A session holds the
queue you are working through and survives a reload or a crash: returning within the continuity
window (12 hours by default, configurable) offers the interrupted session back with your
acknowledgements intact, while an older one is archived to a redacted summary and replaced. Ending
a session archives it the same way and clears its work, leaving your configuration alone.

## Requirements

- Node.js `22.23.1`
- npm `10.9.8`
- Current desktop Chromium and Firefox for browser qualification
- Docker with Compose for the disposable Matrix integration stack

Use `nvm use` when nvm is available. npm enforces the approved runtime line through `engines`
and records its own version through `packageManager`.

## Start locally

```bash
npm ci
npm run setup:browsers
npm run dev
```

No credential is required for the core test path; it provisions a disposable local Matrix server.
Optional remote homeserver compatibility values use the names in
[`.env.test.example`](./.env.test.example), with values only in ignored `.env.test.local`.

## Verification

```bash
npm run check:fast
npm run build
npm run test:browser
npm run test:visual
npm run test:matrix:local
npm run test:webhook:local
npm run test:scale
npm run audit:secrets
npm run audit:tracked
npm run audit:dependencies
npm run report:licenses
```

`npm run check:gate4` runs the complete Phase 4 sequence and `npm run check:gate5` the V1 release
matrix. Both need Docker for the disposable Synapse and ntfy stacks, and both record each step as it
passes so the generated report reflects what actually ran. Generated reports, screenshots, traces,
and the HTML gallery are written beneath ignored `artifacts/`.

`npm run test:soak` is the longevity run and is scheduled separately: it holds the machine and
Docker for six hours by default. Gate 5 reads its recorded manifest rather than re-running it.

See [Deployment](./docs/DEPLOYMENT.md) for the Content Security Policy and hosting notes, plus
[Testing](./docs/TESTING.md), [Architecture](./docs/ARCHITECTURE.md), and the
[ADR index](./docs/adr/README.md) for the decisions behind the implementation.

## What the timestamps mean

Four different times appear in the interface, and they legitimately differ. They are listed here
because a difference between them looks like a fault until you know what each one measures.

| Shown as                          | Measures                                                                        | Source                                                        |
| --------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Detected** (card and detail)    | When AckWatch first observed the activity that opened this item, on this device | `firstDetectedAt`, the browser's clock at intake              |
| **Latest here** (detail)          | When AckWatch last observed activity on this item                               | `lastActivityAt`, the browser's clock at intake               |
| **Sent** (detail)                 | When the sender's homeserver stamped the newest message                         | `origin_server_ts`, resolved on demand from the Matrix client |
| Per-message time (detail history) | When AckWatch observed that individual message                                  | each activity's `detectedAt`                                  |

Consequences worth stating:

- **Detected is always later than Sent**, and can be much later. A message that arrives while the
  page is closed is detected when you next open and arm; a reconnection backlog is detected as it
  drains, not as it was sent.
- **Sent is unavailable when detail cannot be resolved.** The interface says so rather than
  substituting a detection time, because presenting one as the other is worse than showing nothing.
- **Detected uses your browser's clock; Sent uses the homeserver's.** A skewed local clock shows up
  as a gap between them.

## How the three columns are ordered

Each column answers a different question, so each is ordered differently.

| Column                | Order                        | Ranked on                                           |
| --------------------- | ---------------------------- | --------------------------------------------------- |
| **Needs attention**   | Oldest request first         | `firstDetectedAt` — when the item first reached you |
| **Open work**         | Longest acknowledged first   | `acknowledgedAt`, falling back to detection time    |
| **Completed history** | Most recently finished first | `completedAt`, falling back to last activity        |

Two consequences worth knowing:

- **Chasing a request does not move it.** A follow-up message updates the item's last-activity time
  but never its detection time, so someone asking again cannot push their own request above a person
  who has been waiting longer.
- **Reopening restarts the wait.** A completed item that comes back is new work: its detection time
  is reset and it enters the column at the bottom.

Completed history has a search box and a "last N" control. Search covers the item reference printed
on alerts, the sender, the room, and the stored preview — and **only the stored preview**, which is
bounded to 160 characters, so text beyond that point cannot be found here. Both controls are
deliberately ephemeral: they narrow what you are reading now and are gone when the tab closes,
because a filter that persisted would silently hide history the next time you opened the app.

## What an external alert says

A webhook or ntfy alert carries no room, sender, or message text (ALT-012). What it does carry:

| Field              | Meaning                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Item reference** | The first segment of the item's random id, printed on its queue card too. This is how you match an alert to the work it refers to. It reveals nothing about the room or sender. |
| **Event kind**     | Why the alert fired: `New activity`, `Reopened by new activity`, `Still unacknowledged`, or `Acknowledged work still open`.                                                     |
| **Last activity**  | When the newest message on the item arrived.                                                                                                                                    |
| **Waiting**        | How long since the item was **first detected** — not since the last message.                                                                                                    |
| **Reminder N**     | The escalation stage, shown only above zero.                                                                                                                                    |
| **Unseen**         | How many activities on the item you have not looked at.                                                                                                                         |

Two of these surprise people:

- **Waiting is measured from first detection**, so a `New activity` alert reads as a few
  milliseconds — it fires the moment the item is created — while a `Still unacknowledged` reminder
  on the same item reads as twenty-five minutes, because that is genuinely how long the item has
  been open. The same field legitimately spans milliseconds to hours depending on why the alert
  fired.
- **Reminder 0 is the deadline itself**, not a repeat. The stage counts how many repeat intervals
  have elapsed since the deadline first came due, so reminder 4 means the item has sat unactioned
  for four intervals past its deadline. Immediate alerts are always stage 0.

A test sent from settings is titled **AckWatch test notification** and says so in its body, so it
can never be mistaken for real work.

## Message previews are bounded

A stored preview keeps at most 160 characters of message text, so that little plaintext rests on
this device (ADR-0005). When text is dropped the preview ends in an ellipsis and is labelled
**shortened**, so a cut-off message can always be told apart from a short one.

The newest message in an item is shown in full in the detail dialog, resolved on demand from the
Matrix client rather than from AckWatch's own storage. Earlier messages in a thread are shown as
their stored previews.

## Current boundaries

- Monitoring is never represented as continuing after the page closes.
- No analytics, remote fonts, third-party runtime code, or telemetry are included.
- Matrix credentials are session-only; passwords are never retained.
- Monitoring never auto-resumes after reload, and incomplete gap recovery cannot appear healthy.
- Codex does not commit, push, publish, or mutate repository hosting state.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
