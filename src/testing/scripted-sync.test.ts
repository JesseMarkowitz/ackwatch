import { describe, expect, it } from 'vitest';

import type { Clock } from '../domain/clock';
import type { RawMatrixEvent } from '../domain/ingestion';
import { runScriptedSync } from './scripted-sync';

const clock: Clock = { now: () => 5_000 };

function message(eventId: string, sender = '@sender:example.test'): RawMatrixEvent {
  return {
    eventId,
    roomId: '!room:example.test',
    sender,
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: eventId },
  };
}

describe('scripted sync fixture', () => {
  it('proves cache/baseline/arm/stop boundaries and duplicate suppression', async () => {
    const result = await runScriptedSync(
      [
        { kind: 'cache_prepared' },
        { kind: 'event', event: message('$historical'), live: false },
        { kind: 'network_sync' },
        { kind: 'start_monitoring' },
        { kind: 'event', event: message('$accepted') },
        { kind: 'event', event: message('$accepted') },
        { kind: 'event', event: message('$self', '@monitor:example.test') },
        { kind: 'stop_monitoring' },
        { kind: 'event', event: message('$stopped') },
      ],
      clock,
    );

    // The operator's own message is now retained as context rather than ignored, so it appears in
    // the ledger beside the accepted one and no longer counts as a rejection.
    expect(result.ledger.activities.map(({ eventId }) => eventId)).toEqual(['$accepted', '$self']);
    expect(result.ledger.activities.map(({ attention }) => attention)).toEqual([
      'requires_attention',
      'context_only',
    ]);
    expect(result.coverage).toMatchObject({ connection: 'ready', monitoring: 'off' });
    expect(result.ledger.ignoreCounts).toMatchObject({
      backfill_not_recovery: 1,
      monitoring_off: 1,
    });
  });

  it('catches up after an ordinary outage without losing intent or duplicating activity', async () => {
    const result = await runScriptedSync(
      [
        { kind: 'network_sync' },
        { kind: 'start_monitoring' },
        { kind: 'reconnecting' },
        { kind: 'network_sync', catchingUp: true },
        { kind: 'event', event: message('$during-catchup') },
        { kind: 'event', event: message('$during-catchup') },
        { kind: 'network_sync', catchingUp: false },
      ],
      clock,
    );

    expect(result.ledger.activities.map(({ eventId }) => eventId)).toEqual(['$during-catchup']);
    expect(result.ledger.ignoreCounts).toMatchObject({ duplicate_event: 1 });
    expect(result.coverage).toMatchObject({ connection: 'ready', monitoring: 'armed' });
  });
});
