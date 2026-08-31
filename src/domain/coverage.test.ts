import { describe, expect, it } from 'vitest';

import type { Clock } from './clock';
import { CoverageMachine } from './coverage';

const clock: Clock = { now: () => 42_000 };

describe('CoverageMachine', () => {
  it('does not admit monitoring from cached PREPARED state', () => {
    const coverage = new CoverageMachine(clock);
    coverage.beginStartup();
    coverage.observeSync({ state: 'prepared', fromCache: true });

    expect(coverage.snapshot().connection).toBe('cache_restored');
    expect(() => coverage.startMonitoring()).toThrow(/cannot start/i);
  });

  it('requires a processed network sync and an empty ingestion queue', () => {
    const coverage = new CoverageMachine(clock);
    coverage.beginStartup();
    coverage.setIngestionPending(1);
    coverage.observeSync({ state: 'syncing', fromCache: false });

    expect(coverage.snapshot().connection).toBe('catching_up');

    coverage.setIngestionPending(0);

    expect(coverage.snapshot()).toMatchObject({
      connection: 'ready',
      lastConfirmedAt: 42_000,
      networkBaselineConfirmed: true,
    });
  });

  it('retains monitoring intent while reconnecting but never reports healthy coverage', () => {
    const coverage = new CoverageMachine(clock);
    coverage.beginStartup();
    coverage.observeSync({ state: 'syncing' });
    coverage.startMonitoring();

    coverage.observeSync({ state: 'reconnecting' });

    expect(coverage.snapshot()).toMatchObject({ connection: 'reconnecting', monitoring: 'armed' });
  });

  it('keeps failed gap recovery incomplete until it is explicitly resolved', () => {
    const coverage = new CoverageMachine(clock);
    coverage.beginStartup();
    coverage.observeSync({ state: 'syncing' });
    coverage.startMonitoring();
    coverage.beginGap('!room:example.test');
    coverage.failGap('!room:example.test', 'Boundary could not be joined.');
    coverage.observeSync({ state: 'syncing' });

    expect(coverage.snapshot()).toMatchObject({
      connection: 'coverage_incomplete',
      monitoring: 'armed',
      openGapCount: 1,
    });

    coverage.resolveIncompleteGap();
    expect(coverage.snapshot().connection).toBe('ready');
  });

  it('moves a restored failure into retry without briefly claiming healthy coverage', () => {
    const coverage = new CoverageMachine(clock);
    coverage.beginStartup();
    coverage.observeSync({ state: 'syncing' });
    coverage.restoreIncompleteGaps(1, 'Recovery required.');

    coverage.retryIncompleteGap('!room:example.test');
    expect(coverage.snapshot()).toMatchObject({
      connection: 'recovering_gap',
      monitoring: 'off',
      openGapCount: 1,
    });

    coverage.completeGap('!room:example.test');
    expect(coverage.snapshot()).toMatchObject({ connection: 'ready', openGapCount: 0 });
  });

  it('disarms on authorization loss and lock loss', () => {
    const coverage = new CoverageMachine(clock);
    coverage.beginStartup();
    coverage.observeSync({ state: 'syncing' });
    coverage.startMonitoring();
    coverage.observeSync({ state: 'error', authorizationLost: true });

    expect(coverage.snapshot()).toMatchObject({
      connection: 'fatal_error',
      monitoring: 'off',
    });
  });
});
