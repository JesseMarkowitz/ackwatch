# AckWatch instructions

AckWatch watches the Matrix rooms you are responsible for and turns activity that needs a response
into a piece of work you can see, acknowledge, and finish. It exists so that "did anyone answer
that?" has an answer.

Everything it knows lives in your browser. There is no AckWatch server, no account to create, and
no telemetry.

---

## The working model

Four things happen to every piece of work, in order:

1. **Something arrives.** A message in a room you monitor becomes a queue item.
2. **You are alerted.** A sound, a browser notification, a webhook — whatever you have turned on.
3. **You acknowledge it.** This records that you have seen it. It does not mean you have dealt
   with it.
4. **You complete it.** The work is finished and the item moves to history.

Acknowledgement and completion are deliberately separate. "I have seen this" and "this is dealt
with" are different states, and a queue that cannot tell them apart cannot tell you what is
outstanding.

## Signing in

Enter your full Matrix user ID — `@you:example.org`, including the domain — and your password.
AckWatch works out the homeserver address from the domain by reading its published discovery
document.

Your password is used once, to obtain an access token, and is never stored. The token lives in
session storage: closing the tab ends the session.

**If sign-in reports a discovery problem**, the message says which of these happened:

- _No discovery document_ — that domain publishes no homeserver address. This is normal when a
  server's name is its own host. Turn on **Advanced homeserver override** and enter the homeserver
  URL directly.
- _The document could not be read_ — the file exists but the browser was refused it. Usually the
  homeserver's `.well-known` file is missing an `Access-Control-Allow-Origin` header, which is a
  fix on the server. The override works around it in the meantime.
- _Not permitted by this deployment's policy_ — where AckWatch is hosted, its Content Security
  Policy does not list your homeserver. Only whoever deployed it can change that.

Only one tab may hold an account at a time. A second tab reports that the account is already open
rather than quietly corrupting the first one's data.

## Arming monitoring

Monitoring never starts by itself, and never resumes after a reload. You arm it, every time.

This is deliberate: an application that silently resumed would let you believe you were covered
during a period when you were not. Arming waits for the network to confirm the client is live
before it reports that you are covered.

Coverage is reported as separate dimensions — connection, armed state, audio, notification
permission, webhook health — rather than as one green light, because a single indicator would hide
whichever part was broken.

Messages that arrived while you were not armed are **not** turned into work. Monitoring begins when
you arm it.

## The three columns

Each column answers a different question, so each is ordered differently.

| Column                | Order                        | Ranked on                       |
| --------------------- | ---------------------------- | ------------------------------- |
| **Needs attention**   | Oldest request first         | When the item first reached you |
| **Open work**         | Longest acknowledged first   | When you acknowledged it        |
| **Completed history** | Most recently finished first | When it was completed           |

Two consequences worth knowing:

- **Chasing does not work.** A follow-up message updates an item's last-activity time but never its
  detection time, so someone asking again cannot push their request above a person who has been
  waiting longer.
- **Reopening restarts the wait.** A completed item that receives new activity is new work: it
  re-enters the queue at the bottom rather than at its original place.

Completed history has a search box and a "last N" control. Search covers the item reference, the
sender, the room, and the stored preview — and only the stored preview, which is bounded to 160
characters, so text beyond that point cannot be found. Both controls are deliberately temporary:
they narrow what you are reading now and are gone when the tab closes, because a filter that
persisted would silently hide history the next time you opened the app.

## Reactions, and your own messages

A reaction from someone else is a response — often the only response a message gets — so it becomes
activity on the conversation it reacts to and alerts like a message does. That includes a reaction
to something **you** wrote.

A reaction joins the conversation it reacts to rather than starting a new one — including when the
message it reacts to is inside a thread. **A reaction on work you have already completed reopens
it.** That is deliberate: AckWatch cannot tell whether a thumbs-up means "all good" or is the only
response an important question received, and only you can, so it puts the item back in front of you
rather than deciding for you.

Your own messages and your own reactions are kept too, but they never alert and never create work.
They appear in an item's history marked as yours, so a conversation you took part in reads as a
whole rather than as one side of one.

One limitation worth knowing: AckWatch groups a conversation by its thread. Your own message joins
an item's history when it is part of that item's thread. An unrelated message you send in the same
room belongs to no tracked conversation and is not kept.

## The browser tab

While anything needs attention, the tab title carries the count — `(3) AckWatch`. It counts only
work you have not looked at yet; acknowledged work is not counted, because you have already seen it.
The count reads the same whether or not the tab is focused, and it disappears when nothing is
waiting.

## Encrypted conversations on the board

A card from an end-to-end encrypted room carries an **Encrypted** label. Once keys arrive a
decrypted message reads exactly like a plaintext one, so without the label there is no way to tell
which protection a conversation had.

The label describes the **room**, not this device. AckWatch stores the preview unencrypted in your
browser either way — encryption protects the message in transit and on the server, and **Clear
stored data** is what removes it from here.

## Requests addressed to you

A message that names you, or that arrives in a room holding just the two of you, is marked
**Direct** on its card. Once an item has earned that mark it keeps it.

It changes nothing else: no different ordering, no different deadline, no louder alert. A request
from one person is not automatically more urgent than a request from three — it is only easier to
lose among them, and the label is what makes it findable.

## What the timestamps mean

Four different times appear, and they legitimately differ. A difference between them looks like a
fault until you know what each one measures.

| Shown as         | Measures                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| **Detected**     | When AckWatch first observed the activity that opened this item, on this device |
| **Latest here**  | When AckWatch last observed activity on this item                               |
| **Sent**         | When the sender's homeserver stamped the newest message                         |
| Per-message time | When AckWatch observed that individual message                                  |

- **Detected is always later than Sent**, sometimes much later. A message that arrives while the
  page is closed is detected when you next open and arm; a reconnection backlog is detected as it
  drains, not as it was sent.
- **Sent is unavailable when the message cannot be resolved.** The interface says so rather than
  substituting a detection time, because presenting one as the other is worse than showing nothing.
- **Detected uses your browser's clock, Sent uses the homeserver's.** A skewed local clock shows up
  as a gap between them.

## Alerts

Three channels, each turned on separately in **Settings → Alert delivery**.

- **Sound.** A bundled tone plays in the page. Browsers only permit sound after you have interacted
  with the page, so use **Test alert tone** to confirm you will actually hear it — the readiness
  indicator alone cannot tell you that. The test says which sound played, and if you hear nothing
  after it reports success, the browser played it and your device silenced it: check the system
  volume, and on iOS the silent switch.
- **Browser notifications.** These need permission, granted per site, and they obey your operating
  system's do-not-disturb rules. They do not work once the page is closed.
- **Webhook.** A generic JSON endpoint, or an ntfy-compatible one. Test it before relying on it.

### What an external alert says

A webhook or ntfy alert carries no room, sender, or message text.

| Field              | Meaning                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Item reference** | The first segment of the item's id, printed on its queue card too. This is how you match an alert to the work it refers to. It reveals nothing about the room or sender. |
| **Event kind**     | Why the alert fired: `New activity`, `Reopened by new activity`, `Still unacknowledged`, or `Acknowledged work still open`.                                              |
| **Last activity**  | When the newest message on the item arrived.                                                                                                                             |
| **Waiting**        | How long since the item was first detected — not since the last message.                                                                                                 |
| **Reminder N**     | The escalation stage, shown only above zero.                                                                                                                             |
| **Unseen**         | How many activities on the item you have not looked at.                                                                                                                  |

Two of these surprise people:

- **Waiting is measured from first detection**, so a `New activity` alert reads as a few
  milliseconds — it fires the moment the item is created — while a `Still unacknowledged` reminder
  on the same item reads as twenty-five minutes, because that is genuinely how long it has been
  open.
- **Reminder 0 is the deadline itself**, not a repeat. The stage counts repeat intervals elapsed
  since the deadline first came due, so reminder 4 means four intervals unactioned.

A test sent from settings is titled **AckWatch test notification** and says so in its body, so it
can never be mistaken for real work.

### When an alert cannot be delivered

A delivery that fails every attempt stays on the board rather than moving to settings, because a
failed alert is a decision waiting on you, not a preference. The reason is reported as what
actually happened — an unreachable server, a refused credential, or a destination this deployment's
policy does not permit — rather than as a guess.

## Pictures and attachments

A picture posted with no words is work like any other message. Its card reads **Picture** — with the
filename when the sender's client provided one — so a post that is only an image is recognisable
without opening it. Files read **File**, and stickers read **Sticker**.

If a picture does not appear at all, the usual causes are the same as for any message: monitoring
was not armed when it arrived, or you posted it yourself.

## Message previews

A stored preview keeps at most 160 characters of message text, so that little plaintext rests on
this device. When text is dropped the preview ends in an ellipsis and is labelled **shortened**, so
a cut-off message can always be told apart from a short one.

The newest message in an item is shown in full in the detail dialog, fetched on demand. Earlier
messages in a thread are shown as their stored previews.

## Encrypted rooms

AckWatch signs in as its own Matrix device. Like any new device, it starts with no keys, so messages
in encrypted rooms arrive as placeholders reading **waiting for keys** — recorded and alerted on,
but unreadable until the keys reach it. They are never silently dropped, so an encrypted room does
not look empty when it is not.

There are two ways to give it keys, and you only need one.

### If you have your recovery key

Settings → **Durable device security** → **Restore from a recovery key**. Paste the key and press
**Restore security secrets**.

This does more than its name suggests: it reads your secret storage, signs this device with your
cross-signing identity — which is what makes other people's clients willing to share keys with it —
and connects it to your existing key backup so earlier messages can be decrypted.

### If you do not have your recovery key

Verify the AckWatch session from another of your Matrix clients — in Element, Settings → Security &
Privacy → Other sessions → **Verify session**, then compare the emoji. AckWatch shows the same emoji
and its own confirm button.

**Picking the right session in that list.** AckWatch signs in for the session only, so every sign-in
creates a new Matrix device and several AckWatch sessions build up over time. The one you are
looking at is named under **This device** at the top of Durable device security; match that id
against the list in your other client. Sessions you no longer recognise can be signed out from
there.

Verification does two things: it marks this device as trusted, so keys for **new** messages are
shared with it from then on, and it lets this device ask your other device for your secrets, which
normally includes the key-backup key — so older messages usually become readable too.

### Do not use "Set up cross-signing, secret storage, and key backup" for this

That control is for an account that has **no** security set up yet. It creates a **new** recovery key
and a **new** key backup, which replaces what your other clients already use and invalidates the
recovery key you saved. If your account already has security set up, restore or verify instead.

### What the security tiles mean

| Tile                    | What it measures                                                                                                                               | If it is not ready                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Crypto engine**       | Whether the encryption engine started at all.                                                                                                  | `fault` means encryption is unavailable in this browser; nothing else on this panel will work.                                                                                  |
| **Cross-signing**       | Whether this device is signed by your account identity — that is, whether other clients treat it as **yours**. Ready means verified.           | Restore from your recovery key, or verify the session from another client.                                                                                                      |
| **Secret storage**      | Whether AckWatch can read your account's stored secrets.                                                                                       | Restore from your recovery key.                                                                                                                                                 |
| **Key backup**          | Whether this device is connected to your account's key backup — the store other clients call **key storage** — and can pull room keys from it. | Switch key storage on in another Matrix client, then restore here again. A backup can only be created by a client that already holds keys, so AckWatch cannot make one for you. |
| **Device verification** | The state of a verification exchange **happening right now**, not whether the device is trusted. `idle` simply means none is in progress.      | Nothing. Trust is reported by Cross-signing, not here.                                                                                                                          |

### Knowing whether it worked

The tiles at the top of Durable device security are the authoritative answer, and they persist:
**Cross-signing** and **Secret storage** should read Ready, and **Key backup** should read Enabled.
The message beside the button tells you what happened; the tiles tell you where you ended up.

Keys arrive asynchronously, and what happens to messages already in your queue depends on when they
were stored.

- Placeholders ingested **during this page's session** repair themselves as their keys turn up.
- Placeholders from **before a reload** do not repair on their own. The decryption arrives against a
  message the reload discarded, so nothing links it back. **Open the item** — that decrypts it on
  demand and writes the result back, so the card mends itself once you look at it. If the message is
  too old to still be loaded in the Matrix client, it stays a placeholder.

**One thing keys cannot fix:** a message that was never captured. If AckWatch was not armed when a
message arrived, or the message reached it as history rather than as live traffic, no placeholder
was created — and decryption repairs a placeholder rather than creating one. Such a message stays
absent however many keys arrive later. The diagnostics export's `ignoredThisRunByReason` says
whether that is what happened.

## Work sessions

AckWatch monitors for a working session, not indefinitely.

A session holds the queue you are working through and survives a reload or a crash. Return within
the continuity window — 12 hours by default, configurable — and the interrupted session is offered
back with your acknowledgements intact. An older one is archived to a redacted summary and
replaced.

Ending a session archives it the same way and clears its work, leaving your configuration alone.

The window is measured from when the session **started**, not from your last action, so a session
left open longer than the window is retired on the next reload even if you never left.

## Settings

Configuration lives on its own screen, reached from the top bar, so the board stays about work that
needs attention.

- **Alert delivery** — the three channels above, escalation timing, and their test controls.
- **Local durability** — whether the browser has granted persistent storage, and how much is used.
- **Durable device security** — cross-signing and key backup for encrypted rooms.
- **Settings export and import** — the JSON below the buttons is also the import field. Exporting
  copies it to your clipboard and leaves it on screen; if the browser refuses clipboard access the
  status says so and you can select it yourself. An imported file never enables a webhook, so
  importing cannot start sending to a destination you have not confirmed.
- **Diagnostics** — a report describing how this installation is behaving using counts, codes and
  timings only. It includes `ignoredThisRunByReason`, which says how many events were seen and not
  turned into work, and why — `monitoring_off` for anything that arrived before you armed,
  `unsupported_event_type` for an event kind AckWatch does not handle. Those counts cover the
  current run only and reset when the page reloads. It carries no message text, room or event identifiers, senders, or webhook
  destination, so it is safe to attach to a bug report. **Download diagnostics** saves it as a file;
  **Export diagnostics** copies it and shows it for reading.
- **Clear stored data** — permanently deletes this account's queue, history and settings on this
  device. It asks twice. Export anything you want to keep first.

Both exports record the format version, which tells a reader whether it can parse the file, and the
AckWatch version that produced it, which tells you what it came from. They are different numbers on
purpose.

## Installing it as an app

A deployed AckWatch can be installed from the browser — Add to Home Screen on iOS and iPadOS,
Install on Chromium desktop and Android. You get the application without browser chrome, at a real
device viewport.

Installing changes nothing else. There is no service worker: nothing is cached beyond ordinary HTTP,
the installed app is the same page as the tab, and it stops working when closed exactly as the tab
does. Installing does **not** enable notifications on iOS, which Apple raises only through a service
worker AckWatch does not have.

## What AckWatch does not do

These are properties of the product, not defects awaiting a fix.

- **A closed page monitors nothing.** AckWatch runs entirely in the browser tab. Close it and
  monitoring, alerting and delivery all stop. Nothing about it should be read as watching your rooms
  while you are away.
- **Alerts are durable intent, not guaranteed receipt.** AckWatch records that an alert was owed and
  dispatched. It cannot guarantee your desktop showed it, your phone rang, or a webhook receiver
  accepted it exactly once.
- **Nothing syncs between devices.** The queue lives in the browser that built it. Another device,
  or another browser on the same machine, starts empty.
- **Replying elsewhere does not settle an item.** AckWatch does not see your own messages, so
  answering in another Matrix client leaves the item waiting until you acknowledge it here.
- **Chromium and Firefox are supported.** Safari is not qualified.

## Troubleshooting

| What you see                       | What it means                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in fails on a discovery error | See **Signing in** above; the message names which of the three causes it was.                                                                                     |
| `Invalid username or password`     | The homeserver rejected the credentials. Check the domain in your user ID matches the server you mean — an account on one homeserver will not sign in to another. |
| The account is already open        | Another tab holds it. Close that tab, or use the one that has it.                                                                                                 |
| The alert tone is silent           | Run **Test alert tone**. If it reports success, the device silenced it: system volume, or the iOS silent switch.                                                  |
| A webhook test fails               | The message says whether the URL was unreachable, refused the credentials, or was blocked by this deployment's policy. The first is usually a mistyped URL.       |
| Storage says "best effort"         | The browser has not granted persistent storage. Data still persists, but the browser may evict it under pressure.                                                 |
| Sent time is missing on an item    | The original message could not be fetched. The detection time is shown instead, labelled as such.                                                                 |
