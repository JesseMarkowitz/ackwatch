# ADR-0005: Balanced preview privacy

- Status: Accepted
- Date: 2026-08-31

## Decision

The browser list may persist room/sender labels and a Unicode-safe preview of roughly 160
characters. Full decrypted detail is resolved on demand from SDK/crypto stores and is not written
to AckWatch workflow storage. External alerts carry generic non-content metadata only.

## Consequences

Queue identity remains understandable while stored plaintext is bounded. Users can select a generic
preview setting. Full detail can be temporarily unavailable after logout, reload, or missing keys
without losing the workflow item.
