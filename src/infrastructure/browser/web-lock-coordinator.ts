import type { AccountId, InstanceCoordinator, InstanceLease } from '../../application/ports';

interface LockLike {
  readonly name: string;
}

interface LockManagerLike {
  request<T>(
    name: string,
    options: { readonly mode: 'exclusive'; readonly ifAvailable: true },
    callback: (lock: LockLike | null) => Promise<T>,
  ): Promise<T>;
}

export class WebLockCoordinator implements InstanceCoordinator {
  public constructor(
    private readonly lockManager: LockManagerLike | undefined = navigator.locks,
    private readonly onUnexpectedLoss: (accountId: AccountId) => void = () => undefined,
  ) {}

  public async acquire(accountId: AccountId): Promise<InstanceLease | undefined> {
    if (!this.lockManager) throw new Error('This browser does not support exclusive Web Locks.');

    let releaseLock!: () => void;
    let acquiredSettled = false;
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let resolveAcquired!: (lease: InstanceLease | undefined) => void;
    let rejectAcquired!: (error: unknown) => void;
    const acquired = new Promise<InstanceLease | undefined>((resolve, reject) => {
      resolveAcquired = resolve;
      rejectAcquired = reject;
    });
    const lockName = `ackwatch:account:${accountId}`;

    void this.lockManager
      .request(lockName, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) {
          acquiredSettled = true;
          resolveAcquired(undefined);
          return;
        }

        let releasedByOwner = false;
        const lease: InstanceLease = {
          accountId,
          release: async () => {
            if (releasedByOwner) return;
            releasedByOwner = true;
            releaseLock();
          },
        };
        acquiredSettled = true;
        resolveAcquired(lease);
        await released;
      })
      .catch((error: unknown) => {
        if (!acquiredSettled) rejectAcquired(error);
        else this.onUnexpectedLoss(accountId);
      });

    return await acquired;
  }
}
