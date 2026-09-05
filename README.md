# AckWatch

AckWatch is a local-first attention monitor for Matrix. It is an independent open-source project
and is not endorsed by The Matrix.org Foundation or Element.

It is for people responsible for watching a Matrix environment: it notices when new messages
arrive, tracks whether each one has been acknowledged as seen, and tracks whether the work it
created has been completed. "I have seen this" and "this is dealt with" are separate states,
because a queue that cannot tell them apart cannot tell you what is still outstanding.

Everything it knows lives in your browser. There is no AckWatch server, no account to create, and
no telemetry.

## What it does

- **Turns activity into work.** A message in a room you monitor becomes a queue item that stays
  visible until you acknowledge and complete it, with deadlines, thread merge, and reopening.
- **Alerts you.** A bundled tone, browser notifications, and an optional generic or
  ntfy-compatible webhook, with bounded escalation and a durable record of every delivery.
- **Reads encrypted rooms.** A persistent device with cross-signing, secret storage, key backup,
  and emoji verification. Undecryptable events appear as placeholders rather than vanishing.
- **Keeps an honest boundary.** Monitoring starts only when you arm it, never resumes by itself
  after a reload, and stops when the tab closes — and the interface never implies otherwise.

## Quick start

To try it locally:

```bash
npm ci
npm run setup:browsers
npm run dev
```

To deploy it somewhere you can reach from other devices:

```bash
npm run build      # produces a self-contained dist/
```

Serve `dist/` from any static host **over HTTPS** — four browser APIs AckWatch depends on exist
only in a secure context, so it does not work over plain HTTP on anything but `localhost`. You will
also need a Content Security Policy naming your homeserver. Both are covered in
[Deployment](./docs/DEPLOYMENT.md), along with hosts that cannot set response headers, replacing
the alert tone, and the Matrix CORS requirement.

## Documentation

| Read this                                                                                          | For                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Instructions](./instructions.md)                                                                  | Using AckWatch: signing in, arming, the queue, alerts, sessions, settings, troubleshooting. Ships with the build and is linked from the app's top bar. |
| [Deployment](./docs/DEPLOYMENT.md)                                                                 | Hosting it: HTTPS, the Content Security Policy, static hosts, custom alert tone, CORS.                                                                 |
| [Release notes](./RELEASE_NOTES.md)                                                                | What this version does, and the limitations it does not pretend away.                                                                                  |
| [Contributing](./CONTRIBUTING.md)                                                                  | Building and verifying: toolchain, local workflow, the gate commands.                                                                                  |
| [Testing](./docs/TESTING.md), [Architecture](./docs/ARCHITECTURE.md), [ADRs](./docs/adr/README.md) | How it is verified, how it is put together, and why.                                                                                                   |

## License

Apache License 2.0. See [LICENSE](./LICENSE).
