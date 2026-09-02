import { config } from 'zod';

/**
 * Zod probes for `Function` availability to decide whether it may JIT-compile validators. Under a
 * strict Content Security Policy the probe is caught and Zod falls back correctly, but the browser
 * still reports a `securitypolicyviolation` for the attempt — which would mean either shipping a
 * policy with `'unsafe-eval'` or shipping one that reports violations in normal operation.
 * `jitless` skips the probe, which Zod documents for exactly this case.
 *
 * This module must be imported before any module that builds a schema at import time, so it is the
 * first import in the entry point.
 */
config({ jitless: true });
