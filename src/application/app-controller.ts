import type {
  CredentialStore,
  InstanceCoordinator,
  InstanceLease,
  MatrixSessionCredentials,
} from './ports';
import { systemClock, type Clock } from '../domain/clock';
import { CoverageMachine, type CoverageSnapshot } from '../domain/coverage';
import {
  DeveloperLedger,
  type IngestionDecision,
  type IngestionIssue,
  type NormalizationResult,
  type SupportedActivity,
} from '../domain/ingestion';
import type { QueueActivity, QueueCommand, QueueItem } from '../domain/queue';
import {
  BrowserAlertCoordinator,
  type AlertChannelsSnapshot,
  type BrowserAlertCoordinatorPort,
} from './browser-alert-coordinator';
import type { AlertRepositoryPort } from './alert-dispatcher';
import type { EventDetail } from './event-detail';
import { initialCryptoSnapshot, type CryptoSnapshot } from './crypto-status';
import {
  BrowserStorageHealth,
  type BrowserStorageSnapshot,
} from '../infrastructure/browser/storage-health';
import { WebLockCoordinator } from '../infrastructure/browser/web-lock-coordinator';
import { SessionCredentialStore } from '../infrastructure/browser/session-credential-store';
import { MatrixAuthentication, type PreparedLogin } from '../infrastructure/matrix/authentication';
import { MatrixRuntime } from '../infrastructure/matrix/matrix-runtime';
import { CoverageIssueRepository } from '../infrastructure/persistence/coverage-issue-repository';
import {
  WorkflowRepository,
  defaultAccountSettings,
  type AcceptedActivityInput,
  type StorageHealth,
  type UiProjection,
  type WorkflowProjection,
} from '../infrastructure/persistence/workflow-repository';
import {
  defaultSessionContinuityWindowMs,
  type AccountSettingsRecord,
  type WorkSessionRecord,
} from '../infrastructure/persistence/workflow-database';

export type AppPhase =
  'signed_out' | 'discovering' | 'password' | 'connecting' | 'active' | 'blocked' | 'error';

export interface AppSnapshot {
  readonly phase: AppPhase;
  readonly accountLabel: string;
  readonly homeserverLabel?: string;
  readonly preparedLogin?: PreparedLogin;
  readonly coverage: CoverageSnapshot;
  readonly activities: readonly SupportedActivity[];
  readonly ingestionIssues: readonly IngestionIssue[];
  readonly ingestionDecisions: readonly IngestionDecision[];
  readonly queueItems: readonly QueueItem[];
  readonly storage: BrowserStorageSnapshot;
  readonly settings?: AccountSettingsRecord;
  readonly alerts: AlertChannelsSnapshot;
  readonly alertDeliveries?: WorkflowProjection['deliveries'];
  readonly crypto: CryptoSnapshot;
  readonly session: WorkSessionSnapshot;
  readonly error?: string;
}

export interface WorkSessionSnapshot {
  /** `none` before a session is opened, `interrupted` while the user chooses, `active` once running. */
  readonly state: 'none' | 'active' | 'interrupted';
  readonly startedAt?: number;
  readonly continuityWindowMs: number;
  /** Explains an automatic decision, such as retiring a session older than the window. */
  readonly notice?: string;
  /** The redacted summary of the most recently archived session, offered before it is discarded. */
  readonly archivedSummary?: string;
}

export interface AckWatchControllerPort {
  getSnapshot(): AppSnapshot;
  subscribe(listener: () => void): () => void;
  initialize(): Promise<void>;
  prepareLogin(userId: string, homeserverOverride?: string): Promise<void>;
  login(password: string): Promise<void>;
  startMonitoring(): void;
  stopMonitoring(): void;
  retryCoverage(): Promise<void>;
  applyQueueCommand(itemId: string, command: QueueCommand['kind']): Promise<void>;
  requestPersistentStorage(): Promise<void>;
  exportSettings(): Promise<string | undefined>;
  importSettings(serialized: string): Promise<void>;
  updateSettings(patch: Partial<AccountSettingsRecord>): Promise<void>;
  requestNotificationPermission(): Promise<void>;
  setWebhookToken(token: string): void;
  sendTestWebhook(): Promise<void>;
  retryAlertDelivery(deliveryId: string): Promise<void>;
  resolveEventDetail(roomId: string, eventId: string): Promise<EventDetail>;
  loadItemActivities(itemId: string): Promise<readonly QueueActivity[]>;
  bootstrapCryptoSecurity(password: string, recoveryPassphrase?: string): Promise<string>;
  restoreCryptoSecurity(recoveryKey: string): Promise<void>;
  requestOwnDeviceVerification(): Promise<void>;
  acceptVerificationRequest(): Promise<void>;
  startSasVerification(): Promise<void>;
  confirmSasVerification(matches: boolean): Promise<void>;
  cancelOwnDeviceVerification(): Promise<void>;
  continueInterruptedSession(): Promise<void>;
  startNewSession(): Promise<void>;
  endSession(): Promise<string | undefined>;
  logout(): Promise<void>;
}

export interface AppControllerDependencies {
  readonly clock?: Clock;
  readonly authentication?: MatrixAuthentication;
  readonly credentialStore?: CredentialStore;
  readonly instanceCoordinator?: InstanceCoordinator;
  readonly createIssueRepository?: () => CoverageIssueRepository;
  readonly createRuntime?: (
    options: ConstructorParameters<typeof MatrixRuntime>[0],
  ) => MatrixRuntimePort;
  readonly storageHealth?: BrowserStorageHealthPort;
  readonly createWorkflowRepository?: (
    onStorageHealth: (health: StorageHealth) => void,
  ) => WorkflowRepositoryPort;
  readonly createAlertCoordinator?: (options: {
    readonly repository: WorkflowRepositoryPort;
    readonly accountId: string;
    readonly clock: Clock;
    readonly getSettings: () => AccountSettingsRecord;
    readonly onChange: () => void;
  }) => BrowserAlertCoordinatorPort;
}

export interface BrowserStorageHealthPort {
  inspect(): Promise<BrowserStorageSnapshot>;
  requestPersistence(): Promise<BrowserStorageSnapshot>;
}

export interface WorkflowRepositoryPort extends AlertRepositoryPort {
  open(): Promise<void>;
  acceptActivity(input: AcceptedActivityInput): Promise<unknown>;
  applyMaintenance(
    accountId: string,
    targetEventId: string,
    command: Parameters<WorkflowRepository['applyMaintenance']>[2],
  ): Promise<boolean>;
  recordIngestionIssue(
    issue: Parameters<WorkflowRepository['recordIngestionIssue']>[0],
  ): Promise<void>;
  activeWorkSession(accountId: string): Promise<WorkSessionRecord | undefined>;
  startWorkSession(accountId: string, startedAt: number): Promise<WorkSessionRecord>;
  summarizeWorkSession(
    accountId: string,
    session: WorkSessionRecord,
    endedAt: number,
    endReason: NonNullable<WorkSessionRecord['endReason']>,
  ): Promise<string>;
  clearSessionWork(accountId: string): Promise<void>;
  closeWorkSession(
    sessionId: string,
    endedAt: number,
    endReason: NonNullable<WorkSessionRecord['endReason']>,
  ): Promise<void>;
  beginMonitoringSession(accountId: string, sessionId: string, startedAt: number): Promise<void>;
  endMonitoringSession(sessionId: string, stoppedAt: number, stopReason: string): Promise<void>;
  applyCommand(accountId: string, itemId: string, command: QueueCommand): Promise<void>;
  projection(accountId: string): Promise<WorkflowProjection>;
  uiProjection(accountId: string): Promise<UiProjection>;
  itemActivities(accountId: string, itemId: string): Promise<readonly QueueActivity[]>;
  getSettings(accountId: string): Promise<AccountSettingsRecord>;
  putSettings(settings: AccountSettingsRecord): Promise<void>;
  exportSettings(accountId: string): Promise<string>;
  importSettings(accountId: string, serialized: string): Promise<AccountSettingsRecord>;
  retryAlertDelivery(accountId: string, deliveryId: string, now: number): Promise<void>;
  close(): void;
}

export interface MatrixRuntimePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  logout(): Promise<void>;
  retryCoverageIssues(): Promise<void>;
  resolveEventDetail?(roomId: string, eventId: string): Promise<EventDetail>;
  bootstrapCryptoSecurity?(password: string, recoveryPassphrase?: string): Promise<string>;
  restoreCryptoSecurity?(recoveryKey: string): Promise<void>;
  requestOwnDeviceVerification?(): Promise<CryptoSnapshot>;
  acceptVerificationRequest?(): Promise<CryptoSnapshot>;
  startSasVerification?(): Promise<CryptoSnapshot>;
  confirmSasVerification?(matches: boolean): Promise<void>;
  cancelOwnDeviceVerification?(): Promise<void>;
}

export class AckWatchController implements AckWatchControllerPort {
  private readonly clock: Clock;
  private readonly coverage: CoverageMachine;
  private readonly authentication: MatrixAuthentication;
  private readonly credentialStore: CredentialStore;
  private readonly instanceCoordinator: InstanceCoordinator;
  private readonly createIssueRepository: () => CoverageIssueRepository;
  private readonly createRuntime: (
    options: ConstructorParameters<typeof MatrixRuntime>[0],
  ) => MatrixRuntimePort;
  private readonly storageHealth: BrowserStorageHealthPort;
  private readonly createWorkflowRepository: (
    onStorageHealth: (health: StorageHealth) => void,
  ) => WorkflowRepositoryPort;
  private readonly createAlertCoordinator: NonNullable<
    AppControllerDependencies['createAlertCoordinator']
  >;
  private readonly ledger = new DeveloperLedger();
  private readonly listeners = new Set<() => void>();
  private phase: AppPhase = 'signed_out';
  private preparedLogin: PreparedLogin | undefined;
  private credentials: MatrixSessionCredentials | undefined;
  private runtime: MatrixRuntimePort | undefined;
  private workflow: WorkflowRepositoryPort | undefined;
  private lease: InstanceLease | undefined;
  private error: string | undefined;
  private workflowProjection: UiProjection = {
    items: [],
    deliveries: [],
    quarantineCount: 0,
  };
  private storageSnapshot: BrowserStorageSnapshot = {
    available: true,
    persistenceSupported: false,
  };
  private accountSettings: AccountSettingsRecord | undefined;
  private monitoringSessionId: string | undefined;
  private workSession: WorkSessionRecord | undefined;
  private sessionState: WorkSessionSnapshot['state'] = 'none';
  private sessionNotice: string | undefined;
  private archivedSummary: string | undefined;
  private alerts: BrowserAlertCoordinatorPort | undefined;
  private cryptoSnapshot: CryptoSnapshot = initialCryptoSnapshot;
  private currentSnapshot: AppSnapshot;

  public constructor(dependencies: AppControllerDependencies = {}) {
    this.clock = dependencies.clock ?? systemClock;
    this.coverage = new CoverageMachine(this.clock);
    this.authentication = dependencies.authentication ?? new MatrixAuthentication(this.clock);
    this.credentialStore = dependencies.credentialStore ?? new SessionCredentialStore();
    this.instanceCoordinator =
      dependencies.instanceCoordinator ??
      new WebLockCoordinator(navigator.locks, () => {
        this.coverage.fatal('Exclusive account ownership was lost. Monitoring was disarmed.');
        this.emit();
      });
    this.createIssueRepository =
      dependencies.createIssueRepository ?? (() => new CoverageIssueRepository());
    this.createRuntime = dependencies.createRuntime ?? ((options) => new MatrixRuntime(options));
    this.storageHealth = dependencies.storageHealth ?? new BrowserStorageHealth();
    this.createWorkflowRepository =
      dependencies.createWorkflowRepository ??
      ((onStorageHealth) =>
        new WorkflowRepository('ackwatch-workflow', undefined, undefined, onStorageHealth));
    this.createAlertCoordinator =
      dependencies.createAlertCoordinator ??
      ((options) =>
        new BrowserAlertCoordinator(
          options.repository,
          options.accountId,
          options.clock,
          options.getSettings,
          { onChange: options.onChange },
        ));
    this.currentSnapshot = this.buildSnapshot();
  }

  public getSnapshot = (): AppSnapshot => this.currentSnapshot;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public async initialize(): Promise<void> {
    const restored = await this.credentialStore.read();
    if (!restored) return;
    await this.connect(restored);
  }

  public async prepareLogin(userId: string, homeserverOverride?: string): Promise<void> {
    this.phase = 'discovering';
    this.error = undefined;
    this.emit();
    try {
      this.preparedLogin = await this.authentication.prepare(userId, homeserverOverride);
      if (!this.preparedLogin.passwordSupported) {
        throw new Error(
          `This homeserver does not advertise password login. Advertised flows: ${this.preparedLogin.advertisedFlows.join(', ') || 'none'}.`,
        );
      }
      this.phase = 'password';
    } catch (error: unknown) {
      this.phase = 'error';
      this.error = error instanceof Error ? error.message : 'Homeserver discovery failed.';
    }
    this.emit();
  }

  public async login(password: string): Promise<void> {
    const prepared = this.preparedLogin;
    if (!prepared) throw new Error('Homeserver discovery must finish before login.');
    this.phase = 'connecting';
    this.error = undefined;
    this.emit();
    try {
      const credentials = await this.authentication.loginWithPassword(prepared, password);
      await this.credentialStore.write(credentials);
      await this.connect(credentials);
    } catch (error: unknown) {
      await this.credentialStore.clear();
      this.phase = 'error';
      this.error = error instanceof Error ? error.message : 'Matrix login failed.';
      this.emit();
    }
  }

  public startMonitoring(): void {
    void this.alerts?.prepareForMonitoring();
    try {
      if (this.sessionState === 'none') void this.startNewSession();
      this.coverage.startMonitoring();
      this.error = undefined;
      const sessionId = crypto.randomUUID();
      this.monitoringSessionId = sessionId;
      void this.workflow
        ?.beginMonitoringSession(this.credentials?.accountId ?? '', sessionId, this.clock.now())
        .catch((error: unknown) => this.handleWorkflowFailure(error));
    } catch (error: unknown) {
      this.error = error instanceof Error ? error.message : 'Monitoring could not start.';
    }
    this.emit();
  }

  public stopMonitoring(): void {
    this.coverage.stopMonitoring();
    void this.endMonitoringSession('user_stop');
    this.emit();
  }

  public async applyQueueCommand(itemId: string, kind: QueueCommand['kind']): Promise<void> {
    const accountId = this.credentials?.accountId;
    if (!accountId || !this.workflow) return;
    const at = this.clock.now();
    const command: QueueCommand =
      kind === 'manual_reopen' ? { kind, at, cycleId: crypto.randomUUID() } : { kind, at };
    try {
      await this.workflow.applyCommand(accountId, itemId, command);
      await this.refreshWorkflow();
    } catch (error: unknown) {
      this.error = error instanceof Error ? error.message : 'Workflow command failed.';
    }
    this.emit();
  }

  public async requestPersistentStorage(): Promise<void> {
    this.storageSnapshot = await this.storageHealth.requestPersistence();
    this.emit();
  }

  public async exportSettings(): Promise<string | undefined> {
    const accountId = this.credentials?.accountId;
    return accountId && this.workflow ? await this.workflow.exportSettings(accountId) : undefined;
  }

  public async importSettings(serialized: string): Promise<void> {
    const accountId = this.credentials?.accountId;
    if (!accountId || !this.workflow) return;
    this.accountSettings = await this.workflow.importSettings(accountId, serialized);
    this.emit();
  }

  public async updateSettings(patch: Partial<AccountSettingsRecord>): Promise<void> {
    const accountId = this.credentials?.accountId;
    if (!accountId || !this.workflow || !this.accountSettings) return;
    const next: AccountSettingsRecord = {
      ...this.accountSettings,
      ...patch,
      accountId,
      schemaVersion: 3,
      updatedAt: this.clock.now(),
    };
    await this.workflow.putSettings(next);
    this.accountSettings = await this.workflow.getSettings(accountId);
    this.emit();
  }

  public async requestNotificationPermission(): Promise<void> {
    await this.alerts?.requestNotificationPermission();
    this.emit();
  }

  public setWebhookToken(token: string): void {
    this.alerts?.setWebhookToken(token);
  }

  public async sendTestWebhook(): Promise<void> {
    await this.alerts?.sendTestWebhook();
    this.emit();
  }

  public async retryAlertDelivery(deliveryId: string): Promise<void> {
    const accountId = this.credentials?.accountId;
    if (!accountId || !this.workflow) return;
    await this.workflow.retryAlertDelivery(accountId, deliveryId, this.clock.now());
    await this.alerts?.dispatch();
    await this.refreshWorkflow();
    this.emit();
  }

  public async resolveEventDetail(roomId: string, eventId: string): Promise<EventDetail> {
    return (
      (await this.runtime?.resolveEventDetail?.(roomId, eventId)) ?? {
        availability: 'unavailable',
        roomId,
        eventId,
        reason: 'client_unavailable',
        detail: 'Full detail is unavailable outside the active Matrix session.',
      }
    );
  }

  public async bootstrapCryptoSecurity(
    password: string,
    recoveryPassphrase?: string,
  ): Promise<string> {
    if (!this.runtime?.bootstrapCryptoSecurity) throw new Error('Crypto is not available.');
    return await this.runtime.bootstrapCryptoSecurity(password, recoveryPassphrase);
  }

  public async restoreCryptoSecurity(recoveryKey: string): Promise<void> {
    if (!this.runtime?.restoreCryptoSecurity) throw new Error('Crypto is not available.');
    await this.runtime.restoreCryptoSecurity(recoveryKey);
  }

  public async requestOwnDeviceVerification(): Promise<void> {
    if (!this.runtime?.requestOwnDeviceVerification) throw new Error('Crypto is not available.');
    this.cryptoSnapshot = await this.runtime.requestOwnDeviceVerification();
    this.emit();
  }

  public async acceptVerificationRequest(): Promise<void> {
    if (!this.runtime?.acceptVerificationRequest) throw new Error('Crypto is not available.');
    this.cryptoSnapshot = await this.runtime.acceptVerificationRequest();
    this.emit();
  }

  public async startSasVerification(): Promise<void> {
    if (!this.runtime?.startSasVerification) throw new Error('Crypto is not available.');
    this.cryptoSnapshot = await this.runtime.startSasVerification();
    this.emit();
  }

  public async confirmSasVerification(matches: boolean): Promise<void> {
    if (!this.runtime?.confirmSasVerification) throw new Error('Crypto is not available.');
    await this.runtime.confirmSasVerification(matches);
  }

  public async cancelOwnDeviceVerification(): Promise<void> {
    await this.runtime?.cancelOwnDeviceVerification?.();
  }

  public async retryCoverage(): Promise<void> {
    if (!this.runtime) return;
    this.error = undefined;
    try {
      await this.runtime.retryCoverageIssues();
    } catch (error: unknown) {
      this.error = error instanceof Error ? error.message : 'Coverage recovery retry failed.';
    }
    this.emit();
  }

  public async logout(): Promise<void> {
    this.coverage.stopMonitoring();
    await this.endMonitoringSession('logout');
    try {
      await this.runtime?.logout();
    } finally {
      await this.credentialStore.clear();
      await this.lease?.release();
      this.runtime = undefined;
      this.alerts?.clearWebhookToken();
      this.alerts?.stop();
      this.alerts = undefined;
      this.workflow?.close();
      this.workflow = undefined;
      this.lease = undefined;
      this.credentials = undefined;
      this.preparedLogin = undefined;
      this.error = undefined;
      this.workflowProjection = { items: [], deliveries: [], quarantineCount: 0 };
      this.accountSettings = undefined;
      this.cryptoSnapshot = initialCryptoSnapshot;
      this.phase = 'signed_out';
      this.coverage.signOut();
      this.emit();
    }
  }

  public async teardown(): Promise<void> {
    this.coverage.stopMonitoring();
    await this.endMonitoringSession('page_teardown');
    await this.runtime?.stop();
    this.alerts?.stop();
    this.workflow?.close();
    await this.lease?.release();
  }

  private async connect(credentials: MatrixSessionCredentials): Promise<void> {
    this.phase = 'connecting';
    this.credentials = credentials;
    this.emit();
    const lease = await this.instanceCoordinator.acquire(credentials.accountId);
    if (!lease) {
      this.phase = 'blocked';
      this.error = 'Another AckWatch tab owns this Matrix account session.';
      this.emit();
      return;
    }
    this.lease = lease;

    let startupStage = 'browser storage inspection';
    try {
      this.storageSnapshot = await this.storageHealth.inspect();
      if (!this.storageSnapshot.available) {
        throw new Error(this.storageSnapshot.fault ?? 'Durable browser storage is unavailable.');
      }
      startupStage = 'workflow storage open';
      const workflow = this.createWorkflowRepository((health) => {
        if (health.state === 'healthy') return;
        this.storageSnapshot = { ...this.storageSnapshot, fault: health.detail };
        this.coverage.fatal(health.detail);
        this.emit();
      });
      this.workflow = workflow;
      await workflow.open();
      this.workflowProjection = await workflow.uiProjection(credentials.accountId);
      this.accountSettings = await workflow.getSettings(credentials.accountId);
      startupStage = 'work session resolution';
      await this.resolveWorkSession(workflow, credentials.accountId);
      startupStage = 'alert coordinator initialization';
      this.alerts = this.createAlertCoordinator({
        repository: workflow,
        accountId: credentials.accountId,
        clock: this.clock,
        getSettings: () =>
          this.accountSettings ?? defaultAccountSettings(credentials.accountId, this.clock.now()),
        onChange: () => {
          void this.refreshWorkflow().then(
            () => this.emit(),
            (error: unknown) => this.handleWorkflowFailure(error),
          );
        },
      });
      // An interrupted session has not been adopted yet, so nothing may be alerted on until the
      // user chooses. Alerting begins with the session.
      if (this.sessionState === 'active') this.alerts.start();
      startupStage = 'Matrix runtime construction';
      const runtime = this.createRuntime({
        clock: this.clock,
        coverage: this.coverage,
        credentials,
        credentialStore: this.credentialStore,
        issues: this.createIssueRepository(),
        ledger: this.ledger,
        onChange: () => this.emit(),
        onNormalized: async (result) => this.handleNormalized(result),
        onCryptoChange: (snapshot) => {
          this.cryptoSnapshot = snapshot;
          this.emit();
        },
      });
      this.runtime = runtime;
      this.phase = 'active';
      startupStage = 'Matrix runtime startup';
      await runtime.start();
      this.emit();
    } catch (error: unknown) {
      await lease.release();
      this.lease = undefined;
      this.runtime = undefined;
      this.workflow?.close();
      this.alerts?.stop();
      this.alerts = undefined;
      this.workflow = undefined;
      this.phase = 'error';
      this.coverage.fatal(
        error instanceof Error
          ? `${startupStage}: ${error.message}`
          : `${startupStage}: Matrix client startup failed safely.`,
      );
      this.error = this.coverage.snapshot().fault ?? 'Matrix client startup failed safely.';
      this.emit();
    }
  }

  private async handleNormalized(result: NormalizationResult): Promise<void> {
    const workflow = this.workflow;
    const accountId = this.credentials?.accountId;
    if (!workflow || !accountId) throw new Error('Workflow storage is unavailable.');
    if (result.kind === 'activity') {
      await workflow.acceptActivity({
        accountId: result.accountId,
        eventId: result.eventId,
        roomId: result.roomId,
        sender: result.sender,
        eventType: result.eventType,
        messageType: result.messageType,
        preview: result.preview,
        detectedAt: result.detectedAt,
        localSequence: result.localSequence,
        provenance: result.provenance,
        contentState: result.contentState,
        ...(result.decryptionFailureCode === undefined
          ? {}
          : { decryptionFailureCode: result.decryptionFailureCode }),
        ...(result.media === undefined ? {} : { media: result.media }),
        relationKind: result.relationKind,
        ...(result.relationEventId === undefined
          ? {}
          : { relationEventId: result.relationEventId }),
        ...(result.roomName === undefined ? {} : { roomName: result.roomName }),
      });
      await this.refreshWorkflow();
      void this.alerts?.dispatch().catch((error: unknown) => this.handleAlertFailure(error));
      return;
    }
    if (result.kind === 'maintenance') {
      const command =
        result.mutation === 'edit'
          ? ({
              kind: 'apply_edit',
              ...(result.preview === undefined ? {} : { preview: result.preview }),
            } as const)
          : result.mutation === 'redaction'
            ? ({ kind: 'apply_redaction' } as const)
            : result.mutation === 'decryption_success'
              ? ({
                  kind: 'enrich_decrypted_content',
                  preview: result.preview ?? '',
                  ...(result.messageType === undefined ? {} : { messageType: result.messageType }),
                  ...(result.media === undefined ? {} : { media: result.media }),
                } as const)
              : ({
                  kind: 'record_decryption_failure',
                  reasonCode: result.decryptionFailureCode ?? 'UNKNOWN_ERROR',
                } as const);
      await workflow.applyMaintenance(accountId, result.targetEventId, command);
      await this.refreshWorkflow();
      return;
    }
    if (result.kind === 'issue') {
      await workflow.recordIngestionIssue({
        accountId,
        code: result.code,
        detail: result.detail,
        detectedAt: result.detectedAt,
        ...(result.eventId === undefined ? {} : { eventId: result.eventId }),
        ...(result.roomId === undefined ? {} : { roomId: result.roomId }),
      });
    }
  }

  private async refreshWorkflow(): Promise<void> {
    const accountId = this.credentials?.accountId;
    if (accountId && this.workflow) {
      this.workflowProjection = await this.workflow.uiProjection(accountId);
    }
  }

  /**
   * Decides what the queue on disk means for this page load. A session older than the continuity
   * window is retired automatically; a recent one is offered back to the user, because a reload or
   * a crash mid-session must not cost them the acknowledgements they were working through.
   */
  private async resolveWorkSession(
    workflow: WorkflowRepositoryPort,
    accountId: string,
  ): Promise<void> {
    const existing = await workflow.activeWorkSession(accountId);
    if (!existing) {
      this.sessionState = 'none';
      this.workSession = undefined;
      return;
    }
    const windowMs =
      this.accountSettings?.sessionContinuityWindowMs ?? defaultSessionContinuityWindowMs;
    if (this.clock.now() - existing.startedAt >= windowMs) {
      await this.retireSession(workflow, accountId, existing, 'stale_auto_new');
      this.workSession = await workflow.startWorkSession(accountId, this.clock.now());
      this.sessionState = 'active';
      this.sessionNotice =
        'The previous session was older than the continuity window, so it was archived and a new session started.';
      return;
    }
    this.workSession = existing;
    this.sessionState = 'interrupted';
  }

  /** Archives a session's redacted summary, then clears its work. The export always precedes the
   * delete, so nothing is discarded without a record of it. */
  private async retireSession(
    workflow: WorkflowRepositoryPort,
    accountId: string,
    session: WorkSessionRecord,
    reason: NonNullable<WorkSessionRecord['endReason']>,
  ): Promise<void> {
    const endedAt = this.clock.now();
    this.archivedSummary = await workflow.summarizeWorkSession(accountId, session, endedAt, reason);
    await workflow.clearSessionWork(accountId);
    await workflow.closeWorkSession(session.id, endedAt, reason);
    await this.refreshWorkflow();
  }

  public async continueInterruptedSession(): Promise<void> {
    if (this.sessionState !== 'interrupted') return;
    this.sessionState = 'active';
    this.sessionNotice = undefined;
    this.alerts?.start();
    this.emit();
  }

  public async startNewSession(): Promise<void> {
    const accountId = this.credentials?.accountId;
    if (!accountId || !this.workflow) return;
    try {
      if (this.workSession) {
        await this.retireSession(this.workflow, accountId, this.workSession, 'user_new');
      }
      this.workSession = await this.workflow.startWorkSession(accountId, this.clock.now());
      this.sessionState = 'active';
      this.sessionNotice = undefined;
      this.alerts?.start();
    } catch (error: unknown) {
      this.handleWorkflowFailure(error);
    }
    this.emit();
  }

  /** Ends the session, returning its redacted summary so the caller can offer it before it goes. */
  public async endSession(): Promise<string | undefined> {
    const accountId = this.credentials?.accountId;
    if (!accountId || !this.workflow || !this.workSession) return undefined;
    try {
      // Monitoring must not keep running into a session that no longer exists.
      this.coverage.stopMonitoring();
      await this.endMonitoringSession('session_end');
      await this.retireSession(this.workflow, accountId, this.workSession, 'user_end');
      this.workSession = undefined;
      this.sessionState = 'none';
      this.sessionNotice = undefined;
      this.alerts?.stop();
    } catch (error: unknown) {
      this.handleWorkflowFailure(error);
    }
    this.emit();
    return this.archivedSummary;
  }

  public async loadItemActivities(itemId: string): Promise<readonly QueueActivity[]> {
    const accountId = this.credentials?.accountId;
    if (!accountId || !this.workflow) return [];
    return await this.workflow.itemActivities(accountId, itemId);
  }

  private async endMonitoringSession(reason: string): Promise<void> {
    const sessionId = this.monitoringSessionId;
    this.monitoringSessionId = undefined;
    if (sessionId && this.workflow) {
      try {
        await this.workflow.endMonitoringSession(sessionId, this.clock.now(), reason);
      } catch (error: unknown) {
        this.handleWorkflowFailure(error);
      }
    }
  }

  private handleWorkflowFailure(error: unknown): void {
    const detail = error instanceof Error ? error.message : 'Workflow persistence failed.';
    this.storageSnapshot = { ...this.storageSnapshot, fault: detail };
    this.coverage.fatal(detail);
    this.error = detail;
    this.emit();
  }

  private handleAlertFailure(error: unknown): void {
    this.error = error instanceof Error ? error.message : 'Alert dispatch failed.';
    this.emit();
  }

  private emit(): void {
    this.currentSnapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): AppSnapshot {
    const ledger = this.ledger.snapshot();
    const homeserverLabel = this.credentials?.baseUrl ?? this.preparedLogin?.baseUrl;
    return {
      phase: this.phase,
      accountLabel: this.credentials?.userId ?? this.preparedLogin?.userId ?? 'Not signed in',
      ...(homeserverLabel === undefined ? {} : { homeserverLabel }),
      ...(this.preparedLogin === undefined ? {} : { preparedLogin: this.preparedLogin }),
      coverage: this.coverage.snapshot(),
      activities: ledger.activities,
      ingestionIssues: ledger.issues,
      ingestionDecisions: ledger.decisions,
      queueItems: this.workflowProjection.items,
      storage: this.storageSnapshot,
      alerts: this.alerts?.snapshot() ?? {
        audio: 'disabled',
        notifications: 'disabled',
        webhook: 'disabled',
      },
      alertDeliveries: this.workflowProjection.deliveries,
      crypto: this.cryptoSnapshot,
      session: {
        state: this.sessionState,
        continuityWindowMs:
          this.accountSettings?.sessionContinuityWindowMs ?? defaultSessionContinuityWindowMs,
        ...(this.workSession === undefined ? {} : { startedAt: this.workSession.startedAt }),
        ...(this.sessionNotice === undefined ? {} : { notice: this.sessionNotice }),
        ...(this.archivedSummary === undefined ? {} : { archivedSummary: this.archivedSummary }),
      },
      ...(this.accountSettings === undefined ? {} : { settings: this.accountSettings }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }
}
