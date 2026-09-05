import { describe, expect, it, vi } from 'vitest';

import { bundledAlertTone, bundledAlertToneSeconds } from './alert-tone';
import { CUSTOM_TONE_CANDIDATES, resolveAlertTone } from './alert-tone-source';

describe('the bundled alert tone', () => {
  /*
   * The tone this replaced was seventeen samples of 8-bit audio: 2.1 milliseconds, which is a
   * click. Nobody could hear it, and the first person to try assumed their machine was at fault.
   * A duration floor is crude, but it is exactly the property that was wrong.
   */
  it('is long enough and loud enough to be heard', () => {
    expect(bundledAlertToneSeconds).toBeGreaterThan(0.3);
    expect(bundledAlertToneSeconds).toBeLessThan(2);

    const [, base64] = bundledAlertTone.split(',');
    const bytes = Uint8Array.from(atob(base64 ?? ''), (character) => character.codePointAt(0) ?? 0);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');

    const view = new DataView(bytes.buffer);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    expect(bitsPerSample).toBe(16);

    const samples = new Int16Array(bytes.buffer, 44, (bytes.length - 44) / 2);
    expect(samples.length / sampleRate).toBeCloseTo(bundledAlertToneSeconds, 2);
    // Near full scale. The old tone's problem was not only its length.
    const peak = samples.reduce((loudest, sample) => Math.max(loudest, Math.abs(sample)), 0);
    expect(peak).toBeGreaterThan(0.7 * 32_767);
  });
});

describe('resolveAlertTone', () => {
  it('prefers a file the deployment dropped in, in candidate order', async () => {
    const probe = vi.fn(async (url: string) => url === './alert-tone.mp3');

    await expect(resolveAlertTone(probe)).resolves.toEqual({
      source: './alert-tone.mp3',
      custom: './alert-tone.mp3',
    });
    // Stops at the first hit rather than probing on.
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('falls back to the bundled tone when the deployment has none', async () => {
    const probe = vi.fn(async () => false);

    await expect(resolveAlertTone(probe)).resolves.toEqual({
      source: bundledAlertTone,
      custom: undefined,
    });
    expect(probe).toHaveBeenCalledTimes(CUSTOM_TONE_CANDIDATES.length);
  });
});
