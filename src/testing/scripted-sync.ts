import { SerialIngestion } from '../application/serial-ingestion';
import type { Clock } from '../domain/clock';
import { CoverageMachine } from '../domain/coverage';
import { DeveloperLedger, type RawMatrixEvent } from '../domain/ingestion';

export type ScriptedSyncStep =
  | { readonly kind: 'cache_prepared' }
  | { readonly kind: 'network_sync'; readonly catchingUp?: boolean }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'start_monitoring' }
  | { readonly kind: 'stop_monitoring' }
  | { readonly kind: 'event'; readonly event: RawMatrixEvent; readonly live?: boolean };

export async function runScriptedSync(
  steps: readonly ScriptedSyncStep[],
  clock: Clock,
  ownUserId = '@monitor:example.test',
) {
  const coverage = new CoverageMachine(clock);
  const ledger = new DeveloperLedger();
  const ingestion = new SerialIngestion(ownUserId, coverage, ledger, () => undefined);
  let sequence = 0;
  coverage.beginStartup();

  for (const step of steps) {
    switch (step.kind) {
      case 'cache_prepared':
        coverage.observeSync({ state: 'prepared', fromCache: true });
        break;
      case 'network_sync':
        coverage.observeSync({
          state: 'syncing',
          ...(step.catchingUp === undefined ? {} : { catchingUp: step.catchingUp }),
        });
        await ingestion.idle();
        break;
      case 'reconnecting':
        coverage.observeSync({ state: 'reconnecting' });
        break;
      case 'start_monitoring':
        coverage.startMonitoring();
        break;
      case 'stop_monitoring':
        coverage.stopMonitoring();
        break;
      case 'event':
        ingestion.enqueue({
          accountId: `${ownUserId}|https://example.test`,
          event: step.event,
          provenance: step.live === false ? 'backfill' : 'live',
          localSequence: ++sequence,
          detectedAt: clock.now(),
          eligibleAtDelivery: coverage.isEligibleForNewWork(),
        });
        break;
    }
  }
  await ingestion.idle();
  return { coverage: coverage.snapshot(), ledger: ledger.snapshot() };
}
