# Deploying AckWatch

AckWatch is a static site. It needs no server-side component: the build in `dist/` is
self-contained and runs from a directory root or a configured subpath.

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
media-src data:;
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
- `media-src data:` — the bundled alert tone is a `data:` URI, so no audio is fetched from anywhere.
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

## Matrix CORS

The homeserver must send permissive CORS headers for the client-server API, which Synapse does by
default. A reverse proxy that strips them will make sign-in fail with a network error rather than an
authentication error.

## Subpath hosting

`dist/` uses relative asset paths, so it works at a domain root or under a subpath without
rebuilding. The browser suite covers both.
