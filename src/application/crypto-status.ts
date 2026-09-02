export interface CryptoSnapshot {
  readonly state: 'off' | 'initializing' | 'ready' | 'fault';
  readonly crossSigningReady: boolean;
  readonly secretStorageReady: boolean;
  readonly keyBackupReady: boolean;
  readonly verification: 'idle' | 'requested' | 'ready' | 'started' | 'done' | 'cancelled';
  readonly detail?: string | undefined;
  readonly verificationTransactionId?: string | undefined;
  readonly verificationIncoming?: boolean | undefined;
  readonly verificationSas?:
    | {
        readonly decimal?: readonly [number, number, number];
        readonly emoji?: readonly { readonly symbol: string; readonly name: string }[];
      }
    | undefined;
}

export const initialCryptoSnapshot: CryptoSnapshot = {
  state: 'off',
  crossSigningReady: false,
  secretStorageReady: false,
  keyBackupReady: false,
  verification: 'idle',
};
