# Deploying AckWatch

AckWatch is a static site. It needs no server-side component: the build in `dist/` is
self-contained and runs from a directory root or a configured subpath.

`npm run build` produces `index.html`, a hashed `assets/` directory, the web app manifest and its
icons, and **`instructions.html` with `instructions.css`** — the operator instructions, rendered
from `instructions.md` at build time by `tools/build-instructions.mjs`. They ship with the
deployment because the people who need them are the people using it, who have no checkout; the
application's top bar links to the page. Deploy the whole directory: dropping those two files
leaves a link in the running application pointing at nothing.

## HTTPS is required, not recommended

AckWatch must be served from a secure context: HTTPS, or `localhost` during development. This is
not a hardening preference — four APIs the application depends on are exposed only to secure
contexts, so on a plain `http://` origin other than localhost it does not work:

- **`navigator.locks`** — the single-instance guard that stops two tabs corrupting one account's
  store. It is absent, and sign-in fails with `This browser does not support exclusive Web Locks.`
  This is the first thing an operator hits, and it looks like a browser-support problem rather than
  a deployment one.
- **`crypto.subtle`** — secret storage and key backup need it, so encrypted rooms break.
- **`Notification`** — the notification channel reports itself unsupported.
- **`navigator.storage`** — persistence cannot be requested, so storage stays best-effort.

Serving the build from a LAN IP over HTTP to try it on another device therefore does not work. Use
a host that terminates TLS with a certificate the testing devices already trust.

## Content Security Policy

The policy below is the tightest one the application actually runs under, and the qualification
suite exercises it: `npm run test:browser` serves the production build with this policy applied and
fails if the browser reports a violation while the app starts, renders, and stores data.

Two directives are yours to complete. AckWatch talks to the homeserver the operator signs in to and,
optionally, to a webhook receiver — neither is known when the bundle is built, so a deployment must
name them. Nothing else needs relaxing.

```
default-src 'none';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self';
font-src 'self' data:;
img-src 'self' data:;
media-src 'self' data:;
manifest-src 'self';
connect-src 'self' https://YOUR-HOMESERVER.example https://YOUR-WEBHOOK.example;
base-uri 'none';
form-action 'none';
frame-ancestors 'none';
object-src 'none'
```

Why each non-obvious directive is present:

- `'wasm-unsafe-eval'` — the Matrix Rust crypto implementation is WebAssembly. Without it, encrypted
  rooms cannot be decrypted and monitoring fails at startup. It permits WebAssembly compilation
  only; it does not permit `eval`.
- `media-src 'self' data:` — the bundled alert tone is a `data:` URI, so no audio is fetched from
  anywhere by default. `'self'` is what admits a custom alert tone dropped into the deployment; drop
  the `'self'` and the bundled tone still plays, so the omission shows up only as a custom tone that
  never sounds.
- `manifest-src 'self'` — the web app manifest is fetched under its own directive, which falls back
  to `default-src`. Without this line the manifest is blocked and the application is simply not
  installable, with no visible error on the page.
- `font-src 'self' data:` — most bundled fonts are files, but two small subsets are inlined into the
  stylesheet as `data:` URIs by the build. Without `data:` those two fail to load.
- `connect-src` — must list every homeserver origin your users sign in to, plus any webhook
  receiver origin. A homeserver that is not listed will fail at sign-in, visibly. Listing only the
  origins you intend is what keeps this policy meaningful; widening it to `https:` would permit the
  page to talk to any host and is not recommended.
- `frame-ancestors 'none'` — AckWatch is not designed to be embedded.

There is deliberately no `'unsafe-inline'` and no `'unsafe-eval'`. The production build contains no
inline script or style, and the application sets no inline style attributes.

`'unsafe-eval'` deserves a note, because a strict policy will otherwise report a violation that
looks alarming and is not. Zod probes for `Function` availability to decide whether it may
JIT-compile validators; the probe is caught and Zod falls back correctly, but the browser reports
the attempt. AckWatch sets Zod's `jitless` option at startup so the probe never runs, which is what
Zod documents for this case. Keep `'unsafe-eval'` out of your policy.

## Choosing `connect-src`

`connect-src` is the directive that decides where the page may open connections — `fetch`, XHR,
WebSocket, EventSource. It is the most valuable line in this policy and the only one a deployment
must think about. The page holds a Matrix access token, device keys, and message previews;
`script-src` is what stops foreign code running, and `connect-src` is what stops any code, ours
included, from sending that material somewhere it does not belong.

It also has to name **every** destination the application uses, and two of those are chosen by
people rather than by the deployer:

- the **homeserver** each operator signs in to, plus the **discovery origin** if the server name
  and the homeserver host differ;
- the **webhook endpoint** each operator configures, which is a runtime setting rather than a
  deployment one.

Three shapes, in descending order of how much the directive is worth:

**One homeserver, known webhook.** The common self-hosted case. List them:

```
connect-src 'self' https://matrix.example.org https://ntfy.example.org
```

**A known set.** Several homeservers or webhook hosts, all named on the same line. The same
protection, a longer line, and a change whenever the set changes.

**Anyone, any homeserver.** A public instance cannot enumerate the servers its visitors will use.
There is no tight policy that also works, so the choice is `connect-src 'self' https:` — any HTTPS
host, which keeps the application usable and gives up most of what the directive buys — or shipping
no policy at all, which is strictly worse because it also drops every other directive. This is the
same wall Element Web meets, and why it does not ship a restrictive `connect-src` either.

A destination that is not listed does not fail loudly. The browser refuses the connection before
any network activity and the request rejects with the same `TypeError` an unreachable server
produces. AckWatch listens for the violation the browser reports alongside it, so a refused webhook
is reported as `BLOCKED_BY_CONTENT_SECURITY_POLICY` and the interface says the policy has to be
widened where the application is hosted, rather than blaming the destination. Sign-in says the same
for a homeserver. Neither can be fixed from inside the application, which is exactly why the
message has to name the policy.

## Hosts that cannot set response headers

Some static hosts serve files and offer no way to add a header. Start9 Pages is one: it serves a
directory out of File Browser or Nextcloud, and there is no header configuration anywhere in it.

On a host like that, set `ACKWATCH_META_CSP` at build time and the policy is emitted into
`index.html` as a `<meta http-equiv="Content-Security-Policy">` tag instead:

```
ACKWATCH_META_CSP="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
font-src 'self' data:; img-src 'self' data:; media-src 'self' data:; manifest-src 'self'; \
connect-src 'self' https://YOUR-HOMESERVER.example; base-uri 'none'; form-action 'none'; \
object-src 'none'" npm run build
```

Understand what this costs before relying on it:

- **`frame-ancestors` cannot be delivered this way.** The build drops it, because a browser ignores
  it in a meta policy and logs an error about it. That directive is the anti-clickjacking control,
  so on such a host the page can be framed by another site unless the host sends
  `X-Frame-Options`. Nothing else in the policy is weakened.
- **The policy applies from when the tag is parsed**, not from the first byte. It is the first
  element in `<head>`, ahead of every script and stylesheet, so nothing the application loads
  escapes it — but a header covers the document unconditionally and this does not.
- **`report-uri` and `sandbox` are dropped for the same reason** and are not used here anyway.

A deployment that sets neither the header nor `ACKWATCH_META_CSP` runs with no policy at all. The
application behaves identically — no feature depends on the CSP — but a defence-in-depth layer is
absent, and the deployment is not the configuration this document qualifies. Say so when recording
such a deployment rather than letting it be assumed.

## Start9 Pages

Pages serves a directory that lives on File Browser's or Nextcloud's volume, mounted read-only, so
deployment is a file copy:

1. Build, naming your homeserver in the meta policy as above.
2. Upload the **contents** of `dist/` — not the `dist` folder itself — into a folder in File
   Browser. `index.html` must sit at that folder's root.
3. Add a Pages site pointing at that folder, and attach your domain to the site's interface so
   StartOS issues its certificate.

The build uses relative asset paths and routes with a URL hash, so it needs no rewrite rules and
works at a domain root or a subpath unchanged.

## Replacing the alert tone

Drop a file named **`alert-tone.wav`** or **`alert-tone.mp3`** beside `index.html` and AckWatch
plays it instead of the bundled tone. No rebuild, no setting, and nothing to configure — the file
being there is the whole mechanism. `alert-tone.wav` wins if both are present.

- **Format.** WAV (PCM) and MP3 play in every supported browser. Ogg/Opus does not play in Safari,
  and Safari is unsupported here anyway, so the two names above are the ones worth using.
- **Length.** Keep it under a couple of seconds. Alerts repeat on escalation, and a long sound
  overlaps its own next playing.
- **Confirming it was picked up.** The **Test alert tone** control in settings says which sound it
  played — the deployment's own file, or the bundled one — so a file in the wrong place or with the
  wrong name is visible rather than silently ignored.
- **`media-src 'self'` must be in the policy**, or the browser refuses the file and the bundled
  tone plays in its place.

The candidates are probed once per session, so on a deployment with no custom tone the browser
records two 404s for those names. That is expected and harmless; it is the cost of a file that
needs no configuration to be found.

## Matrix CORS

The homeserver must send permissive CORS headers for the client-server API, which Synapse does by
default. A reverse proxy that strips them will make sign-in fail with a network error rather than an
authentication error.

**The discovery document needs them too, and is the more common omission.** Signing in with a user
ID begins by reading `https://<server-name>/.well-known/matrix/client`, and that file is usually
served by the reverse proxy rather than by Synapse — so it inherits none of Synapse's CORS headers.
Without `Access-Control-Allow-Origin` on it, the browser refuses the read and AckWatch reports that
discovery returned no valid base URL, while the client-server API beside it answers perfectly. The
homeserver's own web interface never shows this, because it is same-origin with the file. In nginx:

```
location ^~ /.well-known/matrix/ {
    default_type application/json;
    add_header Access-Control-Allow-Origin '*' always;
}
```

Until that is fixed, the advanced homeserver override on the sign-in screen skips discovery
entirely: enter the homeserver's base URL and sign in normally.

**`connect-src` must allow the discovery origin as well as the homeserver.** They are frequently
different hosts — a user ID of `@you:example.org` whose homeserver is `https://matrix.example.org`
requires both `https://example.org` and `https://matrix.example.org` in the policy, or discovery is
blocked before it starts. Only the base URL is needed when the server name and the homeserver host
are the same.

## Subpath hosting

`dist/` uses relative asset paths, so it works at a domain root or under a subpath without
rebuilding. The browser suite covers both.
