import {
  ClientEvent,
  createClient,
  AuthType,
  Direction,
  IndexedDBStore,
  type SyncStateData,
  type MatrixClient,
  type MatrixEvent,
  MatrixEventEvent,
  type Room,
  RoomEvent,
  SyncState,
  type EventTimelineSet,
  type IRoomTimelineData,
  type UIAuthCallback,
} from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent.js';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key.js';
import {
  type ShowSasCallbacks,
  type Verifier,
  VerifierEvent,
  VerificationPhase,
  VerificationRequestEvent,
  type VerificationRequest,
} from 'matrix-js-sdk/lib/crypto-api/verification.js';

import { GapRecoveryCoordinator } from '../../application/gap-recovery';
import type { CredentialStore, MatrixSessionCredentials } from '../../application/ports';
import { SerialIngestion } from '../../application/serial-ingestion';
import type { Clock } from '../../domain/clock';
import type { EventDetail } from '../../application/event-detail';
import { initialCryptoSnapshot, type CryptoSnapshot } from '../../application/crypto-status';
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
  readonly onCryptoChange?: (snapshot: CryptoSnapshot) => void;
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

export function sdkNamespace(accountId: string, deviceId: string): string {
  return stableNamespace(`${accountId}|${deviceId}`);
}

function rawEvent(
  event: MatrixEvent,
  room: Room | undefined,
  decryptionUpdate?: RawMatrixEvent['decryptionUpdate'],
): RawMatrixEvent {
  const eventId = event.getId();
  const roomId = event.getRoomId() ?? room?.roomId;
  const sender = event.getSender();
  return {
    ...(eventId === undefined ? {} : { eventId }),
    ...(roomId === undefined ? {} : { roomId }),
    ...(sender === undefined ? {} : { sender }),
    type: event.getType(),
    wireType: event.getWireType(),
    originServerTs: event.getTs(),
    content: event.getContent(),
    ...(event.event.redacts === undefined ? {} : { redacts: event.event.redacts }),
    ...(decryptionUpdate === undefined ? {} : { decryptionUpdate }),
    ...(event.decryptionFailureReason === null
      ? {}
      : { decryptionFailureCode: String(event.decryptionFailureReason) }),
  };
}

export class MatrixRuntime {
  private client?: MatrixClient;
  private store?: IndexedDBStore;
  private readonly latestLiveEventByRoom = new Map<string, string>();
  private readonly pendingGaps = new Map<string, PendingGap>();
  private readonly encryptedEvents = new Set<MatrixEvent>();
  private readonly ingestion: SerialIngestion;
  private readonly gapRecovery: GapRecoveryCoordinator;
  private sequence = 0;
  private cryptoSnapshot: CryptoSnapshot = initialCryptoSnapshot;
  private readonly secretStorageKeys = new Map<string, Uint8Array<ArrayBuffer>>();
  private verificationRequest: VerificationRequest | undefined;
  private verifier: Verifier | undefined;
  private sasCallbacks: ShowSasCallbacks | undefined;

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
    const namespace = sdkNamespace(credentials.accountId, credentials.deviceId);
    const cryptoDatabasePrefix = `ackwatch-sdk-crypto-${namespace}`;
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
      cryptoCallbacks: {
        cacheSecretStorageKey: (keyId, _keyInfo, key) => {
          this.secretStorageKeys.set(keyId, key.slice());
        },
        getSecretStorageKey: async ({ keys }) => {
          for (const keyId of Object.keys(keys)) {
            const key = this.secretStorageKeys.get(keyId);
            if (key) return [keyId, key];
          }
          return null;
        },
      },
    });
    this.client = client;

    store.on('degraded', this.handleStoreDegraded);
    store.on('closed', this.handleStoreClosed);
    client.on(ClientEvent.Sync, this.handleSync);
    client.on(RoomEvent.Timeline, this.handleTimeline);
    client.on(RoomEvent.TimelineReset, this.handleTimelineReset);

    await store.startup();
    this.setCryptoSnapshot({ ...initialCryptoSnapshot, state: 'initializing' });
    try {
      await client.initRustCrypto({ cryptoDatabasePrefix, useIndexedDB: true });
      client.on(CryptoEvent.VerificationRequestReceived, this.handleVerificationRequestReceived);
      this.setCryptoSnapshot({ ...initialCryptoSnapshot, state: 'ready' });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'Rust crypto failed to initialize.';
      this.setCryptoSnapshot({
        ...initialCryptoSnapshot,
        state: 'fault',
        detail,
      });
      throw new Error(`Encrypted Matrix support is unavailable: ${detail}`, { cause: error });
    }
    coverage.markBaselineSyncing();
    this.dependencies.onChange();
    await client.startClient({ initialSyncLimit: 20, lazyLoadMembers: true });
  }

  public async stop(): Promise<void> {
    this.client?.stopClient();
    await this.ingestion.idle();
    this.detachListeners();
    this.dependencies.issues.close();
    this.clearSecretStorageKeys();
  }

  public async logout(): Promise<void> {
    const client = this.client;
    const cryptoDatabasePrefix = `ackwatch-sdk-crypto-${sdkNamespace(
      this.dependencies.credentials.accountId,
      this.dependencies.credentials.deviceId,
    )}`;
    if (client) {
      try {
        await client.logout(true);
      } catch {
        client.stopClient();
      }
    }
    await this.ingestion.idle();
    this.detachListeners();
    await client?.clearStores({ cryptoDatabasePrefix });
    await this.dependencies.credentialStore.clear();
    this.dependencies.issues.close();
    this.dependencies.coverage.signOut();
    this.clearSecretStorageKeys();
    this.setCryptoSnapshot(initialCryptoSnapshot);
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

  public getCryptoSnapshot(): CryptoSnapshot {
    return this.cryptoSnapshot;
  }

  public async refreshCryptoStatus(): Promise<CryptoSnapshot> {
    const crypto = this.client?.getCrypto();
    if (!crypto) return this.cryptoSnapshot;
    try {
      const [crossSigningReady, secretStorageReady, backupVersion] = await Promise.all([
        crypto.isCrossSigningReady(),
        crypto.isSecretStorageReady(),
        crypto.getActiveSessionBackupVersion(),
      ]);
      this.setCryptoSnapshot({
        ...this.cryptoSnapshot,
        state: 'ready',
        crossSigningReady,
        secretStorageReady,
        keyBackupReady: backupVersion !== null,
        detail: undefined,
      });
    } catch (error: unknown) {
      this.setCryptoSnapshot({
        ...this.cryptoSnapshot,
        detail:
          error instanceof Error ? error.message : 'Crypto status is temporarily unavailable.',
      });
    }
    return this.cryptoSnapshot;
  }

  public async bootstrapCryptoSecurity(
    password: string,
    recoveryPassphrase?: string,
  ): Promise<string> {
    const crypto = this.requireCrypto();
    const authUploadDeviceSigningKeys: UIAuthCallback<void> = async (makeRequest) => {
      try {
        await makeRequest(null);
      } catch (error: unknown) {
        const session = this.authSession(error);
        if (!password || !session) throw error;
        await makeRequest({
          type: AuthType.Password,
          identifier: { type: 'm.id.user', user: this.dependencies.credentials.userId },
          password,
          session,
        });
      }
    };
    await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys });
    const generated = await crypto.createRecoveryKeyFromPassphrase(recoveryPassphrase);
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => generated,
      setupNewKeyBackup: true,
    });
    await this.refreshCryptoStatus();
    if (!generated.encodedPrivateKey)
      throw new Error('The SDK did not return an encoded recovery key.');
    return generated.encodedPrivateKey;
  }

  public async restoreCryptoSecurity(recoveryKey: string): Promise<void> {
    const crypto = this.requireCrypto();
    const status = await crypto.getSecretStorageStatus();
    if (!status.defaultKeyId) throw new Error('This account has no default secret-storage key.');
    this.secretStorageKeys.set(status.defaultKeyId, decodeRecoveryKey(recoveryKey));
    await crypto.bootstrapCrossSigning({});
    await crypto.checkKeyBackupAndEnable();
    await this.refreshCryptoStatus();
  }

  public async requestOwnDeviceVerification(): Promise<CryptoSnapshot> {
    const request = await this.requireCrypto().requestOwnUserVerification();
    this.verificationRequest = request;
    request.on(VerificationRequestEvent.Change, this.handleVerificationChange);
    this.handleVerificationChange();
    return this.cryptoSnapshot;
  }

  public async acceptVerificationRequest(): Promise<CryptoSnapshot> {
    const request = this.requireVerificationRequest();
    await request.accept();
    this.handleVerificationChange();
    return this.cryptoSnapshot;
  }

  public async startSasVerification(): Promise<CryptoSnapshot> {
    const request = this.requireVerificationRequest();
    const verifier = await request.startVerification('m.sas.v1');
    if (this.attachVerifier(verifier)) {
      void verifier.verify().catch((error: unknown) => this.handleVerificationFailure(error));
    }
    this.handleVerificationChange();
    return this.cryptoSnapshot;
  }

  public async confirmSasVerification(matches: boolean): Promise<void> {
    const callbacks = this.sasCallbacks;
    if (!callbacks) throw new Error('SAS comparison is not ready.');
    this.sasCallbacks = undefined;
    if (matches) await callbacks.confirm();
    else callbacks.mismatch();
    this.setCryptoSnapshot({ ...this.cryptoSnapshot, verificationSas: undefined });
  }

  public async cancelOwnDeviceVerification(): Promise<void> {
    await this.verificationRequest?.cancel();
    this.handleVerificationChange();
  }

  public async resolveEventDetail(roomId: string, eventId: string): Promise<EventDetail> {
    const client = this.client;
    if (!client) {
      return {
        availability: 'unavailable',
        roomId,
        eventId,
        reason: 'client_unavailable',
        detail: 'The Matrix client is not available in this session.',
      };
    }
    const room = client.getRoom(roomId);
    if (!room) {
      return {
        availability: 'unavailable',
        roomId,
        eventId,
        reason: 'event_not_loaded',
        detail: 'The room is not currently available from the Matrix client.',
      };
    }
    let event = room.findEventById(eventId);
    if (!event) {
      const timeline = await client.getEventTimeline(room.getUnfilteredTimelineSet(), eventId);
      event = timeline?.getEvents().find((candidate) => candidate.getId() === eventId);
    }
    if (!event) {
      return {
        availability: 'unavailable',
        roomId,
        eventId,
        reason: 'event_not_loaded',
        detail: 'Full detail is not loaded; the durable queue preview remains available.',
      };
    }
    if (event.isEncrypted()) await client.decryptEventIfNeeded(event);
    if (event.isDecryptionFailure()) {
      return {
        availability: 'unavailable',
        roomId,
        eventId,
        reason: 'decryption_failed',
        detail: 'Encrypted detail is unavailable until the required room key arrives.',
        ...(event.decryptionFailureReason === null
          ? {}
          : { decryptionFailureCode: String(event.decryptionFailureReason) }),
      };
    }
    const content = event.getContent() as Readonly<Record<string, unknown>>;
    const relatesTo =
      content['m.relates_to'] && typeof content['m.relates_to'] === 'object'
        ? (content['m.relates_to'] as Readonly<Record<string, unknown>>)
        : undefined;
    const reply =
      relatesTo?.['m.in_reply_to'] && typeof relatesTo['m.in_reply_to'] === 'object'
        ? (relatesTo['m.in_reply_to'] as Readonly<Record<string, unknown>>)
        : undefined;
    const relationEventId =
      typeof relatesTo?.event_id === 'string'
        ? relatesTo.event_id
        : typeof reply?.event_id === 'string'
          ? reply.event_id
          : undefined;
    const relationKind =
      relatesTo?.rel_type === 'm.thread'
        ? 'thread'
        : relationEventId === undefined
          ? 'independent'
          : 'reply';
    const messageType = typeof content.msgtype === 'string' ? content.msgtype : event.getType();
    const info =
      content.info && typeof content.info === 'object'
        ? (content.info as Readonly<Record<string, unknown>>)
        : undefined;
    const media =
      messageType === 'm.image' || messageType === 'm.file'
        ? {
            name:
              typeof content.filename === 'string'
                ? content.filename
                : typeof content.body === 'string'
                  ? content.body
                  : 'Attachment',
            ...(typeof info?.mimetype === 'string' ? { mimeType: info.mimetype } : {}),
            ...(typeof info?.size === 'number' && Number.isSafeInteger(info.size) && info.size >= 0
              ? { size: info.size }
              : {}),
            ...(typeof info?.w === 'number' && Number.isSafeInteger(info.w) && info.w >= 0
              ? { width: info.w }
              : {}),
            ...(typeof info?.h === 'number' && Number.isSafeInteger(info.h) && info.h >= 0
              ? { height: info.h }
              : {}),
          }
        : undefined;
    return {
      availability: 'available',
      eventId,
      roomId,
      roomName: room.name || roomId,
      sender: event.getSender() ?? 'Unknown sender',
      originServerTs: event.getTs(),
      eventType: event.getType(),
      messageType,
      body: typeof content.body === 'string' ? content.body : (media?.name ?? 'No textual body.'),
      relationKind,
      ...(relationEventId === undefined ? {} : { relationEventId }),
      encrypted: event.isEncrypted(),
      edited: event.replacingEvent() !== null,
      redacted: event.isRedacted(),
      ...(media === undefined ? {} : { media }),
    };
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
      if (state === SyncState.Syncing) void this.refreshCryptoStatus();
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
      if (event.isEncrypted() && !this.encryptedEvents.has(event)) {
        this.encryptedEvents.add(event);
        event.on(MatrixEventEvent.Decrypted, this.handleDecrypted);
      }
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

  private readonly handleDecrypted = (event: MatrixEvent): void => {
    try {
      const room = this.client?.getRoom(event.getRoomId() ?? '') ?? undefined;
      const update = event.isDecryptionFailure() ? 'failure' : 'success';
      this.ingestion.enqueue(
        this.createEnvelope(rawEvent(event, room, update), 'live', room?.name),
      );
    } catch (error: unknown) {
      this.dependencies.coverage.fatal(
        error instanceof Error ? error.message : 'Decryption callback failed safely.',
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
    this.client?.removeListener(
      CryptoEvent.VerificationRequestReceived,
      this.handleVerificationRequestReceived,
    );
    for (const event of this.encryptedEvents) {
      event.removeListener(MatrixEventEvent.Decrypted, this.handleDecrypted);
    }
    this.encryptedEvents.clear();
    this.verificationRequest?.removeListener(
      VerificationRequestEvent.Change,
      this.handleVerificationChange,
    );
    this.verifier?.removeListener(VerifierEvent.ShowSas, this.handleShowSas);
    this.verificationRequest = undefined;
    this.verifier = undefined;
    this.sasCallbacks = undefined;
  }

  private readonly handleVerificationChange = (): void => {
    const request = this.verificationRequest;
    if (!request) return;
    const verification =
      request.phase === VerificationPhase.Done
        ? 'done'
        : request.phase === VerificationPhase.Cancelled
          ? 'cancelled'
          : request.phase === VerificationPhase.Started
            ? 'started'
            : request.phase === VerificationPhase.Ready
              ? 'ready'
              : 'requested';
    if (request.phase === VerificationPhase.Started && request.verifier) {
      if (this.attachVerifier(request.verifier)) {
        void request.verifier
          .verify()
          .catch((error: unknown) => this.handleVerificationFailure(error));
      }
    }
    this.setCryptoSnapshot({
      ...this.cryptoSnapshot,
      verification,
      verificationIncoming: !request.initiatedByMe,
      ...(verification === 'done' || verification === 'cancelled'
        ? { verificationSas: undefined }
        : {}),
      ...(request.transactionId === undefined
        ? {}
        : { verificationTransactionId: request.transactionId }),
    });
  };

  private readonly handleVerificationRequestReceived = (request: VerificationRequest): void => {
    if (!request.isSelfVerification) return;
    this.verificationRequest?.removeListener(
      VerificationRequestEvent.Change,
      this.handleVerificationChange,
    );
    this.verificationRequest = request;
    request.on(VerificationRequestEvent.Change, this.handleVerificationChange);
    this.handleVerificationChange();
  };

  private attachVerifier(verifier: Verifier): boolean {
    if (this.verifier === verifier) return false;
    this.verifier?.removeListener(VerifierEvent.ShowSas, this.handleShowSas);
    this.verifier = verifier;
    verifier.on(VerifierEvent.ShowSas, this.handleShowSas);
    return true;
  }

  private readonly handleShowSas = (callbacks: ShowSasCallbacks): void => {
    this.sasCallbacks = callbacks;
    this.setCryptoSnapshot({
      ...this.cryptoSnapshot,
      verification: 'started',
      verificationSas: {
        ...(callbacks.sas.decimal === undefined ? {} : { decimal: callbacks.sas.decimal }),
        ...(callbacks.sas.emoji === undefined
          ? {}
          : {
              emoji: callbacks.sas.emoji.map(([symbol, name]) => ({ symbol, name })),
            }),
      },
    });
  };

  private handleVerificationFailure(error: unknown): void {
    this.setCryptoSnapshot({
      ...this.cryptoSnapshot,
      verification: 'cancelled',
      verificationSas: undefined,
      detail: error instanceof Error ? error.message : 'Device verification failed.',
    });
  }

  private requireVerificationRequest(): VerificationRequest {
    if (!this.verificationRequest) throw new Error('No device verification request is active.');
    return this.verificationRequest;
  }

  private setCryptoSnapshot(snapshot: CryptoSnapshot): void {
    this.cryptoSnapshot = snapshot;
    this.dependencies.onCryptoChange?.(snapshot);
  }

  private requireCrypto(): NonNullable<ReturnType<MatrixClient['getCrypto']>> {
    const crypto = this.client?.getCrypto();
    if (!crypto) throw new Error('Rust crypto is not initialized.');
    return crypto;
  }

  private authSession(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const data = 'data' in error ? (error.data as unknown) : undefined;
    if (!data || typeof data !== 'object' || !('session' in data)) return undefined;
    return typeof data.session === 'string' ? data.session : undefined;
  }

  private clearSecretStorageKeys(): void {
    for (const key of this.secretStorageKeys.values()) key.fill(0);
    this.secretStorageKeys.clear();
  }
}
