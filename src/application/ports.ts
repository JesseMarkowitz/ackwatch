import type { Clock } from '../domain/clock';

export type AccountId = string & { readonly accountId: unique symbol };

export interface MonitoringSession {
  readonly id: string;
  readonly accountId: AccountId;
  readonly startedAt: number;
}

export interface MatrixEventEnvelope {
  readonly accountId: AccountId;
  readonly eventId: string;
  readonly roomId: string;
  readonly receivedAt: number;
  readonly payload: unknown;
}

export interface EventSource {
  start(onEvent: (event: MatrixEventEnvelope) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface WorkflowRepository {
  open(accountId: AccountId): Promise<void>;
  close(): Promise<void>;
}

export interface CredentialStore {
  read(): Promise<MatrixSessionCredentials | undefined>;
  write(credentials: MatrixSessionCredentials): Promise<void>;
  clear(): Promise<void>;
}

export interface MatrixSessionCredentials {
  readonly accountId: AccountId;
  readonly baseUrl: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
}

export interface InstanceLease {
  readonly accountId: AccountId;
  release(): Promise<void>;
}

export interface InstanceCoordinator {
  acquire(accountId: AccountId): Promise<InstanceLease | undefined>;
}

export interface LifecyclePort {
  onResume(listener: () => void): () => void;
  onTeardown(listener: () => void): () => void;
}

export interface AlertTransport {
  readonly id: string;
  send(effectId: string): Promise<void>;
}

export interface ApplicationDependencies {
  readonly alerts: readonly AlertTransport[];
  readonly clock: Clock;
  readonly credentials: CredentialStore;
  readonly eventSource: EventSource;
  readonly instanceCoordinator: InstanceCoordinator;
  readonly lifecycle: LifecyclePort;
  readonly workflowRepository: WorkflowRepository;
}
