import { describe, expect, it } from 'vitest';

import type { Clock } from '../domain/clock';
import { CoverageMachine } from '../domain/coverage';
import { DeveloperLedger, type IngestionEnvelope, type RawMatrixEvent } from '../domain/ingestion';
import { SerialIngestion } from './serial-ingestion';
import { GapRecoveryCoordinator, type GapRecoverySource } from './gap-recovery';

const clock: Clock = { now: () => 10_000 };

function event(eventId: string): RawMatrixEvent {
  return {
    eventId,
    roomId: '!room:example.test',
    sender: '@sender:example.test',
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: eventId },
  };
}

function envelope(eventId: string, sequence: number): IngestionEnvelope {
  return {
    accountId: '@monitor:example.test|https://example.test',
    event: event(eventId),
    provenance: 'live',
    localSequence: sequence,
    detectedAt: 10_000 + sequence,
    eligibleAtDelivery: true,
  };
}

function armedCoverage(): CoverageMachine {
  const coverage = new CoverageMachine(clock);
  coverage.beginStartup();
  coverage.observeSync({ state: 'syncing' });
  coverage.startMonitoring();
  return coverage;
}

describe('GapRecoveryCoordinator', () => {
  it('emits recovered events chronologically before buffered live events', async () => {
    const coverage = armedCoverage();
    const emitted: IngestionEnvelope[] = [];
    const coordinator = new GapRecoveryCoordinator(coverage, (item) => emitted.push(item));
    const source: GapRecoverySource = {
      fetchBackward: async () => ({
        chunk: [event('$new-2'), event('$new-1'), event('$known')],
        end: 'done',
      }),
    };

    expect(
      coordinator.begin(
        '@monitor:example.test|https://example.test',
        '!room:example.test',
        '$known',
        'token',
        11_000,
      ),
    ).toBe(true);
    expect(coordinator.bufferIfRecovering(envelope('$returned-live', 4))).toBe(true);

    await expect(coordinator.recover('!room:example.test', source)).resolves.toEqual({
      status: 'complete',
      emitted: 3,
    });
    expect(emitted.map(({ event: item }) => item.eventId)).toEqual([
      '$new-1',
      '$new-2',
      '$returned-live',
    ]);
    expect(coverage.snapshot().connection).toBe('ready');
  });

  it('deduplicates across recovery/live at the ledger boundary', async () => {
    const coverage = armedCoverage();
    const ledger = new DeveloperLedger();
    const ingestion = new SerialIngestion(
      '@monitor:example.test',
      coverage,
      ledger,
      () => undefined,
    );
    const coordinator = new GapRecoveryCoordinator(coverage, (item) => ingestion.enqueue(item));

    coordinator.begin(
      '@monitor:example.test|https://example.test',
      '!room:example.test',
      '$known',
      'token',
      11_000,
    );
    coordinator.bufferIfRecovering(envelope('$duplicate', 4));
    await coordinator.recover('!room:example.test', {
      fetchBackward: async () => ({
        chunk: [event('$duplicate'), event('$known')],
      }),
    });
    await ingestion.idle();

    expect(ledger.snapshot().activities.map(({ eventId }) => eventId)).toEqual(['$duplicate']);
    expect(ledger.snapshot().ignoreCounts).toMatchObject({ duplicate_event: 1 });
  });

  it('never reports healthy coverage when the boundary cannot be joined', async () => {
    const coverage = armedCoverage();
    const coordinator = new GapRecoveryCoordinator(coverage, () => undefined);
    coordinator.begin(
      '@monitor:example.test|https://example.test',
      '!room:example.test',
      '$missing',
      'token-1',
      11_000,
    );

    const result = await coordinator.recover('!room:example.test', {
      fetchBackward: async () => ({ chunk: [event('$new')], end: 'token-1' }),
    });

    expect(result.status).toBe('incomplete');
    expect(coverage.snapshot()).toMatchObject({
      connection: 'coverage_incomplete',
      monitoring: 'armed',
    });
  });

  it('allows a persisted gap to retry after reload while monitoring remains off', async () => {
    const coverage = new CoverageMachine(clock);
    coverage.beginStartup();
    coverage.observeSync({ state: 'syncing' });
    coverage.restoreIncompleteGaps(1, 'Recovery required.');
    coverage.retryIncompleteGap('!room:example.test');
    const emitted: IngestionEnvelope[] = [];
    const coordinator = new GapRecoveryCoordinator(coverage, (item) => emitted.push(item));

    expect(
      coordinator.begin(
        '@monitor:example.test|https://example.test',
        '!room:example.test',
        '$known',
        'token',
        11_000,
        true,
        true,
      ),
    ).toBe(true);
    await coordinator.recover('!room:example.test', {
      fetchBackward: async () => ({ chunk: [event('$recovered'), event('$known')] }),
    });

    expect(emitted.map(({ event: item }) => item.eventId)).toEqual(['$recovered']);
    expect(coverage.snapshot()).toMatchObject({ connection: 'ready', monitoring: 'off' });
  });
});
