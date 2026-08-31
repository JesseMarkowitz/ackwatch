import type { Clock } from './clock';

export type ConnectionCoverageState =
  | 'signed_out'
  | 'starting'
  | 'cache_restored'
  | 'baseline_syncing'
  | 'ready'
  | 'reconnecting'
  | 'catching_up'
  | 'recovering_gap'
  | 'coverage_incomplete'
  | 'fatal_error'
  | 'stopped';

export type MonitoringState = 'off' | 'armed';

export interface CoverageSnapshot {
  readonly connection: ConnectionCoverageState;
  readonly monitoring: MonitoringState;
  readonly lastConfirmedAt?: number;
  readonly fault?: string;
  readonly networkBaselineConfirmed: boolean;
  readonly ingestionPending: number;
  readonly openGapCount: number;
}

export interface SyncObservation {
  readonly state: 'prepared' | 'syncing' | 'reconnecting' | 'catching_up' | 'error' | 'stopped';
  readonly fromCache?: boolean;
  readonly catchingUp?: boolean;
  readonly authorizationLost?: boolean;
  readonly detail?: string;
}

export class CoverageMachine {
  private connection: ConnectionCoverageState = 'signed_out';
  private monitoring: MonitoringState = 'off';
  private lastConfirmedAt: number | undefined;
  private fault: string | undefined;
  private networkBaselineConfirmed = false;
  private ingestionPending = 0;
  private readonly openGaps = new Set<string>();
  private incompleteGapCount = 0;

  public constructor(private readonly clock: Clock) {}

  public snapshot(): CoverageSnapshot {
    return {
      connection: this.connection,
      monitoring: this.monitoring,
      ...(this.lastConfirmedAt === undefined ? {} : { lastConfirmedAt: this.lastConfirmedAt }),
      ...(this.fault === undefined ? {} : { fault: this.fault }),
      networkBaselineConfirmed: this.networkBaselineConfirmed,
      ingestionPending: this.ingestionPending,
      openGapCount: this.openGaps.size + this.incompleteGapCount,
    };
  }

  public beginStartup(): void {
    this.connection = 'starting';
    this.monitoring = 'off';
    this.networkBaselineConfirmed = false;
    this.ingestionPending = 0;
    this.openGaps.clear();
    this.incompleteGapCount = 0;
    this.fault = undefined;
  }

  public observeSync(observation: SyncObservation): void {
    if (this.connection === 'fatal_error') return;

    switch (observation.state) {
      case 'prepared':
      case 'syncing': {
        if (observation.fromCache) {
          if (!this.networkBaselineConfirmed) this.connection = 'cache_restored';
          return;
        }

        if (observation.catchingUp) {
          this.connection = 'catching_up';
          return;
        }

        this.networkBaselineConfirmed = true;
        this.reconcileHealthyState();
        return;
      }
      case 'reconnecting':
        this.connection = 'reconnecting';
        return;
      case 'catching_up':
        this.connection = 'catching_up';
        return;
      case 'error':
        if (observation.authorizationLost) {
          this.fatal(
            observation.detail ?? 'Matrix authorization was lost. Reauthentication is required.',
          );
        } else {
          this.connection = 'reconnecting';
          this.fault = observation.detail ?? 'Matrix synchronization was interrupted.';
        }
        return;
      case 'stopped':
        this.connection = 'stopped';
        this.monitoring = 'off';
        return;
    }
  }

  public markBaselineSyncing(): void {
    if (this.connection !== 'fatal_error') this.connection = 'baseline_syncing';
  }

  public setIngestionPending(pending: number): void {
    if (!Number.isSafeInteger(pending) || pending < 0) {
      throw new Error('Ingestion pending count must be a non-negative safe integer.');
    }
    this.ingestionPending = pending;
    this.reconcileHealthyState();
  }

  public beginGap(roomId: string): void {
    this.openGaps.add(roomId);
    this.connection = 'recovering_gap';
  }

  public completeGap(roomId: string): void {
    this.openGaps.delete(roomId);
    this.reconcileHealthyState();
  }

  public failGap(roomId: string, detail: string): void {
    if (this.openGaps.delete(roomId)) this.incompleteGapCount += 1;
    this.connection = 'coverage_incomplete';
    this.fault = detail;
  }

  public retryIncompleteGap(roomId: string): void {
    if (this.incompleteGapCount < 1) {
      throw new Error('No incomplete synchronization gap is available to retry.');
    }
    this.incompleteGapCount -= 1;
    this.openGaps.add(roomId);
    this.connection = 'recovering_gap';
    this.fault = undefined;
  }

  public resolveIncompleteGap(): void {
    if (this.incompleteGapCount > 0) this.incompleteGapCount -= 1;
    if (this.incompleteGapCount === 0) this.fault = undefined;
    this.reconcileHealthyState();
  }

  public restoreIncompleteGaps(count: number, detail: string): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('Incomplete gap count must be a non-negative safe integer.');
    }
    this.incompleteGapCount = count;
    if (count > 0) {
      this.connection = 'coverage_incomplete';
      this.fault = detail;
    }
  }

  public startMonitoring(): void {
    if (this.connection !== 'ready') {
      throw new Error(`Monitoring cannot start while coverage is ${this.connection}.`);
    }
    this.monitoring = 'armed';
  }

  public stopMonitoring(): void {
    this.monitoring = 'off';
  }

  public fatal(detail: string): void {
    this.connection = 'fatal_error';
    this.monitoring = 'off';
    this.fault = detail;
  }

  public signOut(): void {
    this.connection = 'signed_out';
    this.monitoring = 'off';
    this.networkBaselineConfirmed = false;
    this.ingestionPending = 0;
    this.openGaps.clear();
    this.incompleteGapCount = 0;
    this.lastConfirmedAt = undefined;
    this.fault = undefined;
  }

  public isEligibleForNewWork(): boolean {
    return this.monitoring === 'armed' && this.connection !== 'fatal_error';
  }

  private reconcileHealthyState(): void {
    if (this.connection === 'fatal_error') return;
    if (this.incompleteGapCount > 0) {
      this.connection = 'coverage_incomplete';
      return;
    }
    if (this.openGaps.size > 0) {
      this.connection = 'recovering_gap';
      return;
    }
    if (!this.networkBaselineConfirmed) return;
    if (this.ingestionPending > 0) {
      this.connection = 'catching_up';
      return;
    }

    this.connection = 'ready';
    this.lastConfirmedAt = this.clock.now();
    this.fault = undefined;
  }
}
