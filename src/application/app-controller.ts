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
  type SupportedActivity,
} from '../domain/ingestion';
import { WebLockCoordinator } from '../infrastructure/browser/web-lock-coordinator';
import { SessionCredentialStore } from '../infrastructure/browser/session-credential-store';
import { MatrixAuthentication, type PreparedLogin } from '../infrastructure/matrix/authentication';
import { MatrixRuntime } from '../infrastructure/matrix/matrix-runtime';
import { CoverageIssueRepository } from '../infrastructure/persistence/coverage-issue-repository';

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
  readonly error?: string;
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
}

export interface MatrixRuntimePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  logout(): Promise<void>;
  retryCoverageIssues(): Promise<void>;
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
  private readonly ledger = new DeveloperLedger();
  private readonly listeners = new Set<() => void>();
  private phase: AppPhase = 'signed_out';
  private preparedLogin: PreparedLogin | undefined;
  private credentials: MatrixSessionCredentials | undefined;
  private runtime: MatrixRuntimePort | undefined;
  private lease: InstanceLease | undefined;
  private error: string | undefined;
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
    try {
      this.coverage.startMonitoring();
      this.error = undefined;
    } catch (error: unknown) {
      this.error = error instanceof Error ? error.message : 'Monitoring could not start.';
    }
    this.emit();
  }

  public stopMonitoring(): void {
    this.coverage.stopMonitoring();
    this.emit();
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
    try {
      await this.runtime?.logout();
    } finally {
      await this.credentialStore.clear();
      await this.lease?.release();
      this.runtime = undefined;
      this.lease = undefined;
      this.credentials = undefined;
      this.preparedLogin = undefined;
      this.error = undefined;
      this.phase = 'signed_out';
      this.coverage.signOut();
      this.emit();
    }
  }

  public async teardown(): Promise<void> {
    this.coverage.stopMonitoring();
    await this.runtime?.stop();
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

    try {
      const runtime = this.createRuntime({
        clock: this.clock,
        coverage: this.coverage,
        credentials,
        credentialStore: this.credentialStore,
        issues: this.createIssueRepository(),
        ledger: this.ledger,
        onChange: () => this.emit(),
      });
      this.runtime = runtime;
      this.phase = 'active';
      await runtime.start();
      this.emit();
    } catch (error: unknown) {
      await lease.release();
      this.lease = undefined;
      this.runtime = undefined;
      this.phase = 'error';
      this.coverage.fatal(
        error instanceof Error ? error.message : 'Matrix client startup failed safely.',
      );
      this.error = this.coverage.snapshot().fault ?? 'Matrix client startup failed safely.';
      this.emit();
    }
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
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }
}
