import {
  ClientEvent,
  createClient,
  Direction,
  IndexedDBStore,
  type SyncStateData,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  RoomEvent,
  SyncState,
  type EventTimelineSet,
  type IRoomTimelineData,
} from 'matrix-js-sdk';

import { GapRecoveryCoordinator } from '../../application/gap-recovery';
import type { CredentialStore, MatrixSessionCredentials } from '../../application/ports';
import { SerialIngestion } from '../../application/serial-ingestion';
import type { Clock } from '../../domain/clock';
import type { CoverageMachine, SyncObservation } from '../../domain/coverage';
import type {
  DeveloperLedger,
  IngestionEnvelope,
  NormalizationResult,
  RawMatrixEvent,
} from '../../domain/ingestion';
import type { CoverageIssueRepository } from '../persistence/coverage-issue-repository';
import { matrixErrorCode } from './authentication';

interface PendingGap {
  readonly boundaryEventId: string;
  readonly timelineSet: EventTimelineSet;
  readonly detectedAt: number;
  readonly buffered: IngestionEnvelope[];
}

export interface MatrixRuntimeDependencies {
  readonly clock: Clock;
  readonly coverage: CoverageMachine;
  readonly credentials: MatrixSessionCredentials;
  readonly credentialStore: CredentialStore;
  readonly issues: CoverageIssueRepository;
  readonly ledger: DeveloperLedger;
  readonly onChange: () => void;
  readonly onNormalized?: (result: NormalizationResult) => Promise<void>;
  readonly indexedDB?: IDBFactory;
  readonly localStorage?: Storage;
  readonly fetchFn?: typeof globalThis.fetch;
}

function stableNamespace(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function rawEvent(event: MatrixEvent, room: Room | undefined): RawMatrixEvent {
  const eventId = event.getId();
  const roomId = event.getRoomId() ?? room?.roomId;
  const sender = event.getSender();
  return {
    ...(eventId === undefined ? {} : { eventId }),
    ...(roomId === undefined ? {} : { roomId }),
    ...(sender === undefined ? {} : { sender }),
    type: event.getType(),
    originServerTs: event.getTs(),
    content: event.getContent(),
    ...(event.event.redacts === undefined ? {} : { redacts: event.event.redacts }),
  };
}

export class MatrixRuntime {
  private client?: MatrixClient;
  private store?: IndexedDBStore;
  private readonly latestLiveEventByRoom = new Map<string, string>();
  private readonly pendingGaps = new Map<string, PendingGap>();
  private readonly ingestion: SerialIngestion;
  private readonly gapRecovery: GapRecoveryCoordinator;
  private sequence = 0;

  public constructor(private readonly dependencies: MatrixRuntimeDependencies) {
    this.ingestion = new SerialIngestion(
      dependencies.credentials.userId,
      dependencies.coverage,
      dependencies.ledger,
      dependencies.onChange,
      dependencies.onNormalized,
    );
    this.gapRecovery = new GapRecoveryCoordinator(dependencies.coverage, (envelope) => {
      this.ingestion.enqueue({ ...envelope, localSequence: ++this.sequence });
    });
  }

  public async start(): Promise<void> {
    const { credentials, coverage, issues } = this.dependencies;
    coverage.beginStartup();
    await issues.open();
    const restoredIssues = await issues.listOpen(credentials.accountId);
    if (restoredIssues.length > 0) {
      coverage.restoreIncompleteGaps(
        restoredIssues.length,
        `${restoredIssues.length} unresolved synchronization gap${restoredIssues.length === 1 ? '' : 's'} require attention.`,
      );
    }

    const indexedDB = this.dependencies.indexedDB ?? window.indexedDB;
    const localStorage = this.dependencies.localStorage ?? window.localStorage;
    const namespace = stableNamespace(credentials.accountId);
    const store = new IndexedDBStore({
      indexedDB,
      localStorage,
      dbName: `ackwatch-sdk-sync-${namespace}`,
    });
    this.store = store;

    const tokenRefreshFunction = credentials.refreshToken
      ? async (refreshToken: string) => {
          const refreshClient = createClient({
            baseUrl: credentials.baseUrl,
            accessToken: credentials.accessToken,
            ...(this.dependencies.fetchFn === undefined
              ? {}
              : { fetchFn: this.dependencies.fetchFn }),
          });
          const response = await refreshClient.refreshToken(refreshToken);
          const expiresAt = this.dependencies.clock.now() + response.expires_in_ms;
          await this.dependencies.credentialStore.write({
            ...credentials,
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            expiresAt,
          });
          return {
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            expiry: new Date(expiresAt),
          };
        }
      : undefined;
    const client = createClient({
      baseUrl: credentials.baseUrl,
      accessToken: credentials.accessToken,
      ...(credentials.refreshToken === undefined ? {} : { refreshToken: credentials.refreshToken }),
      userId: credentials.userId,
      deviceId: credentials.deviceId,
      store,
      timelineSupport: true,
      useAuthorizationHeader: true,
      ...(this.dependencies.fetchFn === undefined ? {} : { fetchFn: this.dependencies.fetchFn }),
      ...(tokenRefreshFunction === undefined ? {} : { tokenRefreshFunction }),
    });
    this.client = client;

    store.on('degraded', this.handleStoreDegraded);
    store.on('closed', this.handleStoreClosed);
    client.on(ClientEvent.Sync, this.handleSync);
    client.on(RoomEvent.Timeline, this.handleTimeline);
    client.on(RoomEvent.TimelineReset, this.handleTimelineReset);

    await store.startup();
    coverage.markBaselineSyncing();
    this.dependencies.onChange();
    await client.startClient({ initialSyncLimit: 20, lazyLoadMembers: true });
  }

  public async stop(): Promise<void> {
    this.client?.stopClient();
    await this.ingestion.idle();
    this.detachListeners();
    this.dependencies.issues.close();
  }

  public async logout(): Promise<void> {
    const client = this.client;
    if (client) {
      try {
        await client.logout(true);
      } catch {
        client.stopClient();
      }
    }
    await this.ingestion.idle();
    this.detachListeners();
    await this.store?.deleteAllData();
    await this.dependencies.credentialStore.clear();
    this.dependencies.issues.close();
    this.dependencies.coverage.signOut();
    this.dependencies.onChange();
  }

  public async retryCoverageIssues(): Promise<void> {
    const client = this.client;
    if (!client) throw new Error('Matrix synchronization is not running.');

    const issues = await this.dependencies.issues.listOpen(this.dependencies.credentials.accountId);
    for (const issue of issues) {
      const room = client.getRoom(issue.roomId);
      const token = room?.getLiveTimeline().getPaginationToken(Direction.Backward) ?? null;
      this.dependencies.coverage.retryIncompleteGap(issue.roomId);
      const started = this.gapRecovery.begin(
        issue.accountId,
        issue.roomId,
        issue.boundaryEventId,
        token,
        issue.createdAt,
        true,
        true,
      );
      if (!started) {
        await this.persistGapFailure(
          issue.roomId,
          issue.boundaryEventId,
          issue.createdAt,
          'The current timeline did not provide a recovery token.',
        );
        continue;
      }

      const result = await this.gapRecovery.recover(issue.roomId, this.gapSource(client));
      if (result.status === 'complete') {
        await this.dependencies.issues.resolve(issue.id, this.dependencies.clock.now());
      } else {
        await this.persistGapFailure(
          issue.roomId,
          issue.boundaryEventId,
          issue.createdAt,
          result.detail,
        );
      }
      this.dependencies.onChange();
    }
  }

  public getClient(): MatrixClient | undefined {
    return this.client;
  }

  private readonly handleSync = (
    state: SyncState,
    _previous: SyncState | null,
    data?: SyncStateData,
  ): void => {
    try {
      this.dependencies.coverage.observeSync(this.mapSyncObservation(state, data));
      if ((state === SyncState.Syncing || state === SyncState.Prepared) && !data?.fromCache) {
        this.activatePendingGaps();
      }
      this.dependencies.onChange();
    } catch (error: unknown) {
      this.dependencies.coverage.fatal(
        error instanceof Error ? error.message : 'Unexpected synchronization state failure.',
      );
      this.dependencies.onChange();
    }
  };

  private readonly handleTimeline = (
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline: boolean | undefined,
    removed: boolean,
    data: IRoomTimelineData,
  ): void => {
    try {
      if (removed) return;
      const raw = rawEvent(event, room);
      const roomId = raw.roomId;
      if (!roomId) {
        this.ingestion.enqueue(this.createEnvelope(raw, 'backfill', room?.name));
        return;
      }

      const provenance = toStartOfTimeline || !data.liveEvent ? 'backfill' : 'live';
      const envelope = this.createEnvelope(raw, provenance, room?.name, 0);
      const pending = this.pendingGaps.get(roomId);
      if (pending && provenance === 'live') {
        pending.buffered.push(envelope);
      } else if (!this.gapRecovery.bufferIfRecovering(envelope)) {
        this.ingestion.enqueue({ ...envelope, localSequence: ++this.sequence });
      }

      if (provenance === 'live' && raw.eventId) this.latestLiveEventByRoom.set(roomId, raw.eventId);
    } catch (error: unknown) {
      this.dependencies.coverage.fatal(
        error instanceof Error ? error.message : 'Timeline callback failed safely.',
      );
      this.dependencies.onChange();
    }
  };

  private readonly handleTimelineReset = (
    room: Room | undefined,
    timelineSet: EventTimelineSet,
  ): void => {
    try {
      if (!room || !this.dependencies.coverage.isEligibleForNewWork()) return;
      const boundaryEventId = this.latestLiveEventByRoom.get(room.roomId);
      this.dependencies.coverage.beginGap(room.roomId);
      if (!boundaryEventId) {
        const detail = 'A limited timeline reset had no known local boundary.';
        this.dependencies.coverage.failGap(room.roomId, detail);
        this.persistGapFailureSafely(
          room.roomId,
          `unknown-boundary:${this.dependencies.clock.now()}`,
          this.dependencies.clock.now(),
          detail,
        );
        this.dependencies.onChange();
        return;
      }
      this.pendingGaps.set(room.roomId, {
        boundaryEventId,
        timelineSet,
        detectedAt: this.dependencies.clock.now(),
        buffered: [],
      });
      this.dependencies.onChange();
    } catch (error: unknown) {
      this.dependencies.coverage.fatal(
        error instanceof Error ? error.message : 'Timeline reset handling failed safely.',
      );
      this.dependencies.onChange();
    }
  };

  private activatePendingGaps(): void {
    const client = this.client;
    if (!client) return;
    for (const [roomId, pending] of this.pendingGaps) {
      this.pendingGaps.delete(roomId);
      const token = pending.timelineSet.getLiveTimeline().getPaginationToken(Direction.Backward);
      const started = this.gapRecovery.begin(
        this.dependencies.credentials.accountId,
        roomId,
        pending.boundaryEventId,
        token,
        pending.detectedAt,
        true,
      );
      if (!started) {
        this.persistGapFailureSafely(
          roomId,
          pending.boundaryEventId,
          pending.detectedAt,
          'The limited timeline did not provide a recovery token.',
        );
        continue;
      }
      for (const buffered of pending.buffered) this.gapRecovery.bufferIfRecovering(buffered);
      void this.gapRecovery
        .recover(roomId, this.gapSource(client))
        .then(async (result) => {
          if (result.status === 'incomplete') {
            await this.persistGapFailure(
              roomId,
              pending.boundaryEventId,
              pending.detectedAt,
              result.detail,
            );
          }
          this.dependencies.onChange();
        })
        .catch((error: unknown) => {
          this.dependencies.coverage.failGap(
            roomId,
            error instanceof Error ? error.message : 'Gap recovery persistence failed.',
          );
          this.dependencies.onChange();
        });
    }
  }

  private gapSource(client: MatrixClient) {
    return {
      fetchBackward: async (targetRoomId: string, from: string, limit: number) => {
        const response = await client.createMessagesRequest(
          targetRoomId,
          from,
          limit,
          Direction.Backward,
        );
        return {
          chunk: response.chunk.map((event) => ({
            eventId: event.event_id,
            roomId: targetRoomId,
            sender: event.sender,
            type: event.type,
            originServerTs: event.origin_server_ts,
            content: event.content,
          })),
          ...(response.end === undefined ? {} : { end: response.end }),
        };
      },
    };
  }

  private async persistGapFailure(
    roomId: string,
    boundaryEventId: string,
    createdAt: number,
    detail: string,
  ): Promise<void> {
    await this.dependencies.issues.saveGapFailure({
      accountId: this.dependencies.credentials.accountId,
      roomId,
      boundaryEventId,
      detail,
      createdAt,
      updatedAt: this.dependencies.clock.now(),
    });
  }

  private persistGapFailureSafely(
    roomId: string,
    boundaryEventId: string,
    createdAt: number,
    detail: string,
  ): void {
    void this.persistGapFailure(roomId, boundaryEventId, createdAt, detail).catch(
      (error: unknown) => {
        this.dependencies.coverage.fatal(
          error instanceof Error
            ? `Coverage failure could not be saved: ${error.message}`
            : 'Coverage failure could not be saved.',
        );
        this.dependencies.onChange();
      },
    );
  }

  private createEnvelope(
    event: RawMatrixEvent,
    provenance: IngestionEnvelope['provenance'],
    roomName?: string,
    localSequence = ++this.sequence,
  ): IngestionEnvelope {
    return {
      accountId: this.dependencies.credentials.accountId,
      event,
      provenance,
      localSequence,
      detectedAt: this.dependencies.clock.now(),
      eligibleAtDelivery: this.dependencies.coverage.isEligibleForNewWork(),
      ...(roomName === undefined ? {} : { roomName }),
    };
  }

  private mapSyncObservation(state: SyncState, data?: SyncStateData): SyncObservation {
    switch (state) {
      case SyncState.Prepared:
        return {
          state: 'prepared',
          ...(data?.fromCache === undefined ? {} : { fromCache: data.fromCache }),
        };
      case SyncState.Syncing:
        return {
          state: 'syncing',
          ...(data?.fromCache === undefined ? {} : { fromCache: data.fromCache }),
          ...(data?.catchingUp === undefined ? {} : { catchingUp: data.catchingUp }),
        };
      case SyncState.Catchup:
        return { state: 'catching_up' };
      case SyncState.Reconnecting:
        return { state: 'reconnecting' };
      case SyncState.Error: {
        const code = matrixErrorCode(data?.error);
        return {
          state: 'error',
          authorizationLost: code === 'M_UNKNOWN_TOKEN' || code === 'M_MISSING_TOKEN',
          detail: code
            ? `Matrix synchronization failed (${code}).`
            : 'Matrix synchronization failed.',
        };
      }
      case SyncState.Stopped:
        return { state: 'stopped' };
    }
  }

  private readonly handleStoreDegraded = (): void => {
    this.dependencies.coverage.fatal(
      'The Matrix synchronization store degraded to volatile memory. Monitoring was disarmed.',
    );
    this.dependencies.onChange();
  };

  private readonly handleStoreClosed = (): void => {
    this.dependencies.coverage.fatal(
      'The Matrix synchronization store closed unexpectedly. Monitoring was disarmed.',
    );
    this.dependencies.onChange();
  };

  private detachListeners(): void {
    this.client?.removeListener(ClientEvent.Sync, this.handleSync);
    this.client?.removeListener(RoomEvent.Timeline, this.handleTimeline);
    this.client?.removeListener(RoomEvent.TimelineReset, this.handleTimelineReset);
  }
}
