import { describe, expect, it, vi } from 'vitest';

import { copyOutcome, copyToClipboard } from './clipboard';

describe('copyToClipboard', () => {
  it('reports failure when the clipboard API is absent', async () => {
    // The case this exists for. `navigator.clipboard` is secure-context only, and reaching it with
    // optional chaining resolved as though the copy had succeeded — so the status line claimed the
    // export was on the clipboard while nothing was.
    await expect(copyToClipboard('settings', undefined)).resolves.toBe(false);
  });

  it('reports failure when the browser refuses', async () => {
    const clipboard = {
      writeText: vi.fn(async () => {
        throw new Error('NotAllowedError');
      }),
    };

    await expect(copyToClipboard('settings', clipboard)).resolves.toBe(false);
  });

  it('reports success only when the write resolves', async () => {
    const clipboard = { writeText: vi.fn(async () => undefined) };

    await expect(copyToClipboard('settings', clipboard)).resolves.toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('settings');
  });

  it('tells the operator where the text is when it was not copied', () => {
    expect(copyOutcome(true, 'Settings')).toContain('copied to the clipboard');
    // Not a dead end: the box still holds it, and the message has to say so.
    expect(copyOutcome(false, 'Settings')).toContain('select and copy it');
  });
});
