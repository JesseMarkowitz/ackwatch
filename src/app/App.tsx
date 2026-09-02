import { type FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { AckWatchControllerPort, AppSnapshot } from '../application/app-controller';
import type { FoundationViewModel } from './view-model';
import { signedOutView } from './view-model';
import { matrixEventUri, type QueueActivity, type QueueItem } from '../domain/queue';
import type { EventDetail } from '../application/event-detail';

interface AppProps {
  readonly controller?: AckWatchControllerPort;
  readonly snapshot?: AppSnapshot;
  readonly view?: FoundationViewModel;
}

const noSubscription = () => () => undefined;

function snapshotFromView(view: FoundationViewModel): AppSnapshot {
  const connection = view.isSignedIn
    ? view.connectionTone === 'healthy' || view.connectionTone === 'ready'
      ? 'ready'
      : 'reconnecting'
    : 'signed_out';
  return {
    phase: view.isSignedIn ? 'active' : 'signed_out',
    accountLabel: view.accountLabel,
    session: { state: 'none', continuityWindowMs: 12 * 60 * 60_000 },
    ...(view.isSignedIn ? { homeserverLabel: 'https://example.test' } : {}),
    coverage: {
      connection,
      monitoring: view.isMonitoring ? 'armed' : 'off',
      networkBaselineConfirmed: view.isSignedIn,
      ingestionPending: 0,
      openGapCount: 0,
    },
    activities: [],
    ingestionIssues: [],
    ingestionDecisions: [],
    queueItems: [],
    queueActivities: [],
    storage: { available: true, persistenceSupported: false },
    alerts: { audio: 'disabled', notifications: 'disabled', webhook: 'disabled' },
    crypto: {
      state: 'off',
      crossSigningReady: false,
      secretStorageReady: false,
      keyBackupReady: false,
      verification: 'idle',
    },
  };
}

function Wordmark() {
  return (
    <a className="wordmark" href="./" aria-label="AckWatch home">
      <span className="wordmark__mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>AckWatch</span>
    </a>
  );
}

function HealthPill({ label, tone }: { readonly label: string; readonly tone: string }) {
  return (
    <span className={`health-pill health-pill--${tone}`}>
      <span className="health-pill__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

const coverageLabels: Record<AppSnapshot['coverage']['connection'], string> = {
  signed_out: 'Signed out',
  starting: 'Starting',
  cache_restored: 'Cache restored',
  baseline_syncing: 'Confirming baseline',
  ready: 'Coverage complete',
  reconnecting: 'Reconnecting',
  catching_up: 'Catching up',
  recovering_gap: 'Recovering gap',
  coverage_incomplete: 'Coverage incomplete',
  fatal_error: 'Fatal error',
  stopped: 'Stopped',
};

function coverageTone(connection: AppSnapshot['coverage']['connection']): string {
  if (connection === 'ready') return 'healthy';
  if (['reconnecting', 'catching_up', 'recovering_gap'].includes(connection)) return 'warning';
  if (connection === 'coverage_incomplete' || connection === 'fatal_error') return 'danger';
  return 'neutral';
}

function alertTone(state: AppSnapshot['alerts']['audio']): string {
  if (state === 'ready') return 'healthy';
  if (state === 'retrying' || state === 'permission_required') return 'warning';
  if (state === 'fault') return 'danger';
  return 'neutral';
}

const alertLabels: Record<AppSnapshot['alerts']['audio'], string> = {
  disabled: 'Disabled',
  ready: 'Ready',
  permission_required: 'Needs setup',
  retrying: 'Retrying',
  fault: 'Fault',
};

function AlertSettingsPanel({
  snapshot,
  controller,
}: {
  readonly snapshot: AppSnapshot;
  readonly controller: AckWatchControllerPort | undefined;
}) {
  const settings = snapshot.settings;
  const [endpoint, setEndpoint] = useState(settings?.webhookEndpoint ?? '');
  const [topic, setTopic] = useState(settings?.webhookTopic ?? '');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('');
  const destinationOrigin = useMemo(() => {
    try {
      return endpoint ? new URL(endpoint).origin : 'Not configured';
    } catch {
      return 'Invalid destination';
    }
  }, [endpoint]);
  if (!settings) return null;

  return (
    <section className="alert-settings" aria-labelledby="alert-settings-heading">
      <div>
        <p className="eyebrow">Alert delivery</p>
        <h2 id="alert-settings-heading">Local and webhook alerts</h2>
        <p>
          Alerts are best effort while this page is open. Durable intent survives reload; Matrix
          monitoring does not continue after the page closes.
        </p>
      </div>
      <div className="alert-settings__controls">
        <label>
          <input
            type="checkbox"
            checked={settings.audioEnabled}
            onChange={(event) =>
              void controller?.updateSettings({ audioEnabled: event.target.checked })
            }
          />
          Play bundled alert tone
        </label>
        <label>
          Audio volume {Math.round(settings.audioVolume * 100)}%
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={settings.audioVolume}
            onChange={(event) =>
              void controller?.updateSettings({ audioVolume: Number(event.target.value) })
            }
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.browserNotificationsEnabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              void controller?.updateSettings({ browserNotificationsEnabled: enabled }).then(() => {
                if (enabled) void controller.requestNotificationPermission();
              });
            }}
          />
          Browser notifications while open
        </label>
        <details>
          <summary>Webhook relay</summary>
          <label htmlFor="webhook-preset">Preset</label>
          <select
            id="webhook-preset"
            value={settings.webhookPreset}
            onChange={(event) =>
              void controller?.updateSettings({
                webhookPreset: event.target.value === 'ntfy' ? 'ntfy' : 'generic',
              })
            }
          >
            <option value="generic">Generic JSON</option>
            <option value="ntfy">ntfy-compatible</option>
          </select>
          <label htmlFor="webhook-endpoint">
            {settings.webhookPreset === 'ntfy' ? 'Server URL' : 'HTTPS endpoint'}
          </label>
          <input
            id="webhook-endpoint"
            type="url"
            value={endpoint}
            placeholder="https://alerts.example.test"
            onChange={(event) => setEndpoint(event.target.value)}
          />
          {settings.webhookPreset === 'ntfy' ? (
            <>
              <label htmlFor="webhook-topic">Topic</label>
              <input
                id="webhook-topic"
                value={topic}
                autoComplete="off"
                onChange={(event) => setTopic(event.target.value)}
              />
            </>
          ) : null}
          <label htmlFor="webhook-token">Optional bearer token (session only)</label>
          <input
            id="webhook-token"
            type="password"
            value={token}
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
          />
          <div className="webhook-preview">
            <strong>Destination origin</strong> {destinationOrigin}
            <strong>Privacy tier</strong> Generic metadata only—no room, sender, preview,
            attachment, URI, body, token, or raw event.
          </div>
          <div className="detail-actions">
            <button
              type="button"
              onClick={() => {
                controller?.setWebhookToken(token);
                setToken('');
                void controller
                  ?.updateSettings({
                    webhookEnabled: true,
                    webhookEndpoint: endpoint,
                    webhookTopic: topic,
                  })
                  .then(
                    () => setStatus('Webhook configuration saved. Send a test to verify access.'),
                    () => setStatus('Webhook configuration failed validation.'),
                  );
              }}
            >
              Save and enable
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={!settings.webhookEnabled}
              onClick={() =>
                void controller?.sendTestWebhook().then(
                  () => setStatus('Test notification delivered.'),
                  () => setStatus('Test failed; review webhook health and browser CORS access.'),
                )
              }
            >
              Send test notification
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() =>
                void controller?.updateSettings({ webhookEnabled: false }).then(() => {
                  controller.setWebhookToken('');
                  setStatus('Webhook disabled and session token cleared.');
                })
              }
            >
              Disable webhook
            </button>
          </div>
          <p aria-live="polite">{status}</p>
        </details>
        {(snapshot.alertDeliveries ?? [])
          .filter(({ status: deliveryStatus }) => deliveryStatus === 'exhausted')
          .map((delivery) => (
            <div className="alert-retry" key={delivery.id}>
              <span>
                {delivery.transport} exhausted: {delivery.lastErrorCode ?? 'unknown failure'}
              </span>
              <button
                type="button"
                className="button-secondary"
                onClick={() => void controller?.retryAlertDelivery(delivery.id)}
              >
                Retry delivery
              </button>
            </div>
          ))}
      </div>
    </section>
  );
}

function CryptoSecurityPanel({
  snapshot,
  controller,
}: {
  readonly snapshot: AppSnapshot;
  readonly controller: AckWatchControllerPort | undefined;
}) {
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState('');
  const [status, setStatus] = useState('');

  return (
    <section className="crypto-settings" aria-labelledby="crypto-settings-heading">
      <div>
        <p className="eyebrow">Encrypted Matrix</p>
        <h2 id="crypto-settings-heading">Durable device security</h2>
        <p>
          Rust crypto uses an account-and-device-specific IndexedDB store. Recovery secrets stay in
          memory for this session and are never placed in workflow exports.
        </p>
      </div>
      <dl className="crypto-status">
        <div>
          <dt>Crypto engine</dt>
          <dd>{snapshot.crypto.state}</dd>
        </div>
        <div>
          <dt>Cross-signing</dt>
          <dd>{snapshot.crypto.crossSigningReady ? 'Ready' : 'Setup needed'}</dd>
        </div>
        <div>
          <dt>Secret storage</dt>
          <dd>{snapshot.crypto.secretStorageReady ? 'Ready' : 'Setup needed'}</dd>
        </div>
        <div>
          <dt>Key backup</dt>
          <dd>{snapshot.crypto.keyBackupReady ? 'Enabled' : 'Setup needed'}</dd>
        </div>
        <div>
          <dt>Device verification</dt>
          <dd>{snapshot.crypto.verification}</dd>
        </div>
      </dl>
      <div className="crypto-actions">
        <details>
          <summary>Set up cross-signing, secret storage, and key backup</summary>
          <label htmlFor="crypto-password">
            Current Matrix password for one-time authorization
          </label>
          <input
            id="crypto-password"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <label htmlFor="crypto-passphrase">Optional recovery-key passphrase</label>
          <input
            id="crypto-passphrase"
            type="password"
            value={passphrase}
            autoComplete="new-password"
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <button
            type="button"
            disabled={!password}
            onClick={() => {
              const submittedPassword = password;
              const submittedPassphrase = passphrase || undefined;
              setPassword('');
              setPassphrase('');
              void controller?.bootstrapCryptoSecurity(submittedPassword, submittedPassphrase).then(
                (key) => {
                  setGeneratedRecoveryKey(key);
                  setStatus('Security setup completed. Save the recovery key now.');
                },
                () => setStatus('Security setup failed without retaining the supplied secrets.'),
              );
            }}
          >
            Create recovery and backup
          </button>
          {generatedRecoveryKey ? (
            <output className="recovery-key">
              <strong>Recovery key—store this outside AckWatch</strong>
              <code>{generatedRecoveryKey}</code>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setGeneratedRecoveryKey('')}
              >
                I saved it; clear from screen
              </button>
            </output>
          ) : null}
        </details>
        <details>
          <summary>Restore from a recovery key</summary>
          <label htmlFor="crypto-recovery">Recovery key</label>
          <input
            id="crypto-recovery"
            type="password"
            value={recoveryInput}
            autoComplete="off"
            onChange={(event) => setRecoveryInput(event.target.value)}
          />
          <button
            type="button"
            disabled={!recoveryInput}
            onClick={() => {
              const submitted = recoveryInput;
              setRecoveryInput('');
              void controller?.restoreCryptoSecurity(submitted).then(
                () => setStatus('Recovery key accepted; crypto status refreshed.'),
                () => setStatus('Recovery failed; the key was cleared from this form.'),
              );
            }}
          >
            Restore security secrets
          </button>
        </details>
        <div className="detail-actions">
          {snapshot.crypto.verification === 'requested' && snapshot.crypto.verificationIncoming ? (
            <button
              type="button"
              className="button-secondary"
              onClick={() => void controller?.acceptVerificationRequest()}
            >
              Accept verification request
            </button>
          ) : null}
          {snapshot.crypto.verification === 'ready' ? (
            <button
              type="button"
              className="button-secondary"
              onClick={() => void controller?.startSasVerification()}
            >
              Start emoji verification
            </button>
          ) : null}
          <button
            type="button"
            className="button-secondary"
            onClick={() =>
              void controller?.requestOwnDeviceVerification().then(
                () => setStatus('Verification requested from another device.'),
                () => setStatus('A verification request could not be created.'),
              )
            }
          >
            Verify this device
          </button>
          {['requested', 'ready', 'started'].includes(snapshot.crypto.verification) ? (
            <button
              type="button"
              className="button-secondary"
              onClick={() => void controller?.cancelOwnDeviceVerification()}
            >
              Cancel verification
            </button>
          ) : null}
        </div>
        {snapshot.crypto.verificationSas ? (
          <div className="verification-sas" role="group" aria-label="Device verification code">
            <strong>Compare on both devices</strong>
            {snapshot.crypto.verificationSas.emoji ? (
              <ol>
                {snapshot.crypto.verificationSas.emoji.map(({ symbol, name }) => (
                  <li key={`${symbol}-${name}`}>
                    <span aria-hidden="true">{symbol}</span> {name}
                  </li>
                ))}
              </ol>
            ) : null}
            {snapshot.crypto.verificationSas.decimal ? (
              <p>{snapshot.crypto.verificationSas.decimal.join(' · ')}</p>
            ) : null}
            <div className="detail-actions">
              <button type="button" onClick={() => void controller?.confirmSasVerification(true)}>
                They match
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => void controller?.confirmSasVerification(false)}
              >
                They do not match
              </button>
            </div>
          </div>
        ) : null}
        <p aria-live="polite">{status || snapshot.crypto.detail}</p>
      </div>
    </section>
  );
}

function LoginPanel({
  snapshot,
  controller,
}: {
  readonly snapshot: AppSnapshot;
  readonly controller: AckWatchControllerPort | undefined;
}) {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [showOverride, setShowOverride] = useState(false);
  const [homeserverOverride, setHomeserverOverride] = useState('');
  const passwordStage = snapshot.phase === 'password' || Boolean(snapshot.preparedLogin);

  const submitDiscovery = (event: FormEvent) => {
    event.preventDefault();
    void controller?.prepareLogin(userId, showOverride ? homeserverOverride : undefined);
  };
  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    const submittedPassword = password;
    setPassword('');
    void controller?.login(submittedPassword);
  };

  if (passwordStage) {
    return (
      <form className="connect-card" onSubmit={submitPassword} data-testid="password-form">
        <div className="connect-card__heading">
          <div>
            <p className="eyebrow">Password login advertised</p>
            <h2>Authenticate Matrix</h2>
          </div>
          <span className="step-chip">02</span>
        </div>
        <p className="server-summary">
          <strong>{snapshot.preparedLogin?.userId}</strong>
          <span>{snapshot.preparedLogin?.baseUrl}</span>
        </p>
        <label htmlFor="matrix-password">Password</label>
        <div className="field-row">
          <input
            id="matrix-password"
            name="matrix-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <button type="submit" disabled={!controller || snapshot.phase === 'connecting'}>
            {snapshot.phase === 'connecting' ? 'Connecting…' : 'Sign in'}
          </button>
        </div>
        <p className="field-help">The password is submitted once and is never stored or logged.</p>
      </form>
    );
  }

  return (
    <form className="connect-card" onSubmit={submitDiscovery} data-testid="discovery-form">
      <div className="connect-card__heading">
        <div>
          <p className="eyebrow">Begin a session</p>
          <h2>Connect Matrix</h2>
        </div>
        <span className="step-chip">01</span>
      </div>
      <label htmlFor="matrix-id">Matrix user ID</label>
      <div className="field-row">
        <input
          id="matrix-id"
          name="matrix-id"
          type="text"
          autoComplete="username"
          placeholder="@you:example.org"
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          required
        />
        <button type="submit" disabled={!controller || snapshot.phase === 'discovering'}>
          {snapshot.phase === 'discovering' ? 'Discovering…' : 'Continue'}
        </button>
      </div>
      <label className="override-toggle">
        <input
          type="checkbox"
          checked={showOverride}
          onChange={(event) => setShowOverride(event.target.checked)}
        />
        Advanced homeserver override
      </label>
      {showOverride ? (
        <input
          aria-label="Homeserver URL override"
          type="url"
          placeholder="https://matrix.example.org"
          value={homeserverOverride}
          onChange={(event) => setHomeserverOverride(event.target.value)}
          required
        />
      ) : null}
      <p className="field-help">
        AckWatch validates discovery and offered login flows before asking for a password.
      </p>
    </form>
  );
}

function itemActivity(
  item: QueueItem,
  activities: readonly QueueActivity[],
): QueueActivity | undefined {
  return activities.filter(({ itemId }) => itemId === item.id).at(-1);
}

function deadlineLabel(item: QueueItem): string {
  if (!item.deadline) return 'No active deadline';
  return `${item.deadline.kind === 'acknowledged' ? 'Pending-work' : 'Unacknowledged'} deadline ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(item.deadline.firstAt)}`;
}

function QueueCard({
  item,
  activities,
  controller,
  openDetails,
}: {
  readonly item: QueueItem;
  readonly activities: readonly QueueActivity[];
  readonly controller: AckWatchControllerPort | undefined;
  readonly openDetails: (itemId: string) => void;
}) {
  const latest = itemActivity(item, activities);
  return (
    <article
      className={`queue-card ${item.needsAttention ? 'queue-card--attention' : ''}`}
      data-item-id={item.id}
      data-event-id={latest?.eventId}
    >
      <div className="queue-card__meta">
        <span>{latest?.roomName ?? item.roomId}</span>
        <span>
          {item.activityCount} activit{item.activityCount === 1 ? 'y' : 'ies'}
        </span>
      </div>
      <h3>{latest?.sender ?? 'Matrix activity'}</h3>
      <p>{latest?.preview ?? 'Detail is temporarily unavailable.'}</p>
      <div className="queue-card__status">
        <strong>{item.needsAttention ? 'Needs attention' : item.status}</strong>
        <span>{deadlineLabel(item)}</span>
      </div>
      <div className="queue-card__actions">
        <button type="button" onClick={() => openDetails(item.id)}>
          View details
        </button>
        {item.status === 'ACKNOWLEDGED' && item.needsAttention ? (
          <button
            type="button"
            className="button-secondary"
            onClick={() => void controller?.applyQueueCommand(item.id, 'review_new_activity')}
          >
            Review new activity
          </button>
        ) : null}
        {item.status !== 'COMPLETED' ? (
          <button
            type="button"
            className="button-secondary"
            onClick={() => void controller?.applyQueueCommand(item.id, 'complete')}
          >
            Complete
          </button>
        ) : (
          <button
            type="button"
            className="button-secondary"
            onClick={() => void controller?.applyQueueCommand(item.id, 'manual_reopen')}
          >
            Reopen
          </button>
        )}
      </div>
    </article>
  );
}

function QueueSection({
  title,
  empty,
  items,
  activities,
  controller,
  openDetails,
}: {
  readonly title: string;
  readonly empty: string;
  readonly items: readonly QueueItem[];
  readonly activities: readonly QueueActivity[];
  readonly controller: AckWatchControllerPort | undefined;
  readonly openDetails: (itemId: string) => void;
}) {
  return (
    <section
      className="queue-column"
      aria-labelledby={`queue-${title.replaceAll(' ', '-').toLowerCase()}`}
    >
      <header>
        <h2 id={`queue-${title.replaceAll(' ', '-').toLowerCase()}`}>{title}</h2>
        <span aria-label={`${items.length} items`}>{items.length}</span>
      </header>
      {items.length === 0 ? (
        <p className="queue-column__empty">{empty}</p>
      ) : (
        <div className="queue-column__items">
          {items.map((item) => (
            <QueueCard
              key={item.id}
              item={item}
              activities={activities}
              controller={controller}
              openDetails={openDetails}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ItemDetail({
  item,
  activities,
  controller,
  close,
}: {
  readonly item: QueueItem;
  readonly activities: readonly QueueActivity[];
  readonly controller: AckWatchControllerPort | undefined;
  readonly close: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const latest = itemActivity(item, activities);
  const itemActivities = activities.filter(({ itemId }) => itemId === item.id);
  const uri = latest ? matrixEventUri(latest.roomId, latest.eventId) : undefined;
  const [copyStatus, setCopyStatus] = useState('');
  const [resolvedDetail, setResolvedDetail] = useState<EventDetail>();

  useEffect(() => {
    let active = true;
    if (latest && controller) {
      void controller.resolveEventDetail(latest.roomId, latest.eventId).then((detail) => {
        if (active) setResolvedDetail(detail);
      });
    }
    return () => {
      active = false;
    };
  }, [controller, latest]);

  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const focusable = [
          ...(panel.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? []),
        ];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first && last) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last && first) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  return (
    <div className="detail-backdrop">
      <section
        ref={panel}
        className="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
      >
        <div className="detail-panel__header">
          <div>
            <p className="eyebrow">Queue item</p>
            <h2 id="detail-title">
              {resolvedDetail?.availability === 'available'
                ? resolvedDetail.roomName
                : (latest?.roomName ?? item.roomId)}
            </h2>
          </div>
          <button ref={closeButton} type="button" className="button-secondary" onClick={close}>
            Close details
          </button>
        </div>
        <dl className="detail-facts">
          <div>
            <dt>Sender</dt>
            <dd>
              {resolvedDetail?.availability === 'available'
                ? resolvedDetail.sender
                : (latest?.sender ?? 'Unavailable')}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{item.status}</dd>
          </div>
          <div>
            <dt>Detected</dt>
            <dd>
              {new Date(
                resolvedDetail?.availability === 'available'
                  ? resolvedDetail.originServerTs
                  : (latest?.detectedAt ?? item.firstDetectedAt),
              ).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt>Context</dt>
            <dd>
              {resolvedDetail?.availability === 'available'
                ? resolvedDetail.relationKind
                : (latest?.relationKind ?? 'independent')}
            </dd>
          </div>
        </dl>
        <div className="detail-message">
          <p>
            {resolvedDetail?.availability === 'available'
              ? resolvedDetail.body
              : (latest?.preview ??
                'Full detail is temporarily unavailable from the Matrix client.')}
          </p>
          {latest ? (
            <small>
              {resolvedDetail?.availability === 'available'
                ? resolvedDetail.messageType
                : latest.messageType}
              {latest.edited ? ' · edited' : ''}
              {latest.redacted ? ' · redacted' : ''}
              {latest.contentState !== 'clear' ? ` · ${latest.contentState.replace('_', ' ')}` : ''}
            </small>
          ) : null}
          {resolvedDetail?.availability === 'unavailable' ? (
            <small role="status">
              {resolvedDetail.detail}
              {resolvedDetail.decryptionFailureCode
                ? ` (${resolvedDetail.decryptionFailureCode})`
                : ''}
            </small>
          ) : null}
          {resolvedDetail?.availability === 'available' && resolvedDetail.media ? (
            <dl className="detail-media">
              <div>
                <dt>Attachment</dt>
                <dd>{resolvedDetail.media.name}</dd>
              </div>
              {resolvedDetail.media.mimeType ? (
                <div>
                  <dt>Type</dt>
                  <dd>{resolvedDetail.media.mimeType}</dd>
                </div>
              ) : null}
              {resolvedDetail.media.size !== undefined ? (
                <div>
                  <dt>Size</dt>
                  <dd>{resolvedDetail.media.size} bytes</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
        {itemActivities.length > 1 ? (
          <ol className="detail-activity-list" aria-label="Item activity history">
            {itemActivities.map((activity) => (
              <li key={activity.id}>
                <div>
                  <strong>{activity.sender}</strong>
                  <span>{activity.relationKind}</span>
                </div>
                <p>{activity.preview}</p>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="detail-actions">
          {item.status === 'NEW' || item.status === 'UNACKNOWLEDGED' ? (
            <button
              type="button"
              onClick={() => void controller?.applyQueueCommand(item.id, 'acknowledge')}
            >
              Acknowledge
            </button>
          ) : null}
          {item.status !== 'COMPLETED' ? (
            <button
              type="button"
              className="button-secondary"
              onClick={() => void controller?.applyQueueCommand(item.id, 'complete')}
            >
              Complete
            </button>
          ) : null}
          {uri ? (
            <a className="button-link" href={uri}>
              Open in Matrix
            </a>
          ) : null}
          {uri ? (
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(uri).then(
                  () => setCopyStatus('Matrix URI copied.'),
                  () => setCopyStatus('Copy was blocked; select the URI from item diagnostics.'),
                );
              }}
            >
              Copy Matrix URI
            </button>
          ) : null}
        </div>
        <p className="field-help">
          Matrix links require a locally installed client that handles the matrix: scheme. Link and
          copy actions do not mark work viewed or acknowledged.
        </p>
        <p className="sr-status" aria-live="polite">
          {copyStatus}
        </p>
      </section>
    </div>
  );
}

export function App({ controller, snapshot: suppliedSnapshot, view = signedOutView }: AppProps) {
  const fallbackSnapshot = useMemo(
    () => suppliedSnapshot ?? snapshotFromView(view),
    [suppliedSnapshot, view],
  );
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? (() => fallbackSnapshot),
    controller?.getSnapshot ?? (() => fallbackSnapshot),
  );
  const connection = snapshot.coverage.connection;
  const healthy = connection === 'ready' && snapshot.coverage.monitoring === 'armed';
  const isSignedIn = ['active', 'connecting', 'blocked'].includes(snapshot.phase);
  const lastConfirmed = snapshot.coverage.lastConfirmedAt
    ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(
        snapshot.coverage.lastConfirmedAt,
      )
    : 'Not yet confirmed';
  const lastProcessedEventId = snapshot.ingestionDecisions.at(-1)?.eventId;
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [settingsTransfer, setSettingsTransfer] = useState('');
  const [settingsStatus, setSettingsStatus] = useState('');
  const selectedItem = snapshot.queueItems.find(({ id }) => id === selectedItemId);
  const attentionItems = snapshot.queueItems.filter(
    (item) => item.status !== 'COMPLETED' && item.needsAttention,
  );
  const openItems = snapshot.queueItems.filter(
    (item) => item.status !== 'COMPLETED' && !item.needsAttention,
  );
  const completedItems = snapshot.queueItems.filter((item) => item.status === 'COMPLETED');
  const openDetails = (itemId: string) => {
    const item = snapshot.queueItems.find(({ id }) => id === itemId);
    setSelectedItemId(itemId);
    if (item?.status === 'NEW') void controller?.applyQueueCommand(itemId, 'mark_viewed');
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <Wordmark />
        <p className="topbar__descriptor">A local-first attention monitor for Matrix</p>
        {isSignedIn ? (
          <button
            className="topbar__action"
            type="button"
            onClick={() => void controller?.logout()}
          >
            Sign out
          </button>
        ) : (
          <button className="icon-button" type="button" aria-label="Open settings" disabled>
            <span aria-hidden="true">•••</span>
          </button>
        )}
      </header>

      <section className="health-strip" aria-label="Monitoring health">
        <div className="health-strip__identity">
          <p className="eyebrow">Account</p>
          <p className="health-strip__account">{snapshot.accountLabel}</p>
          {snapshot.homeserverLabel ? (
            <p className="health-strip__server">{snapshot.homeserverLabel}</p>
          ) : null}
        </div>
        <dl className="health-grid">
          <div>
            <dt>Connection</dt>
            <dd>
              <HealthPill label={coverageLabels[connection]} tone={coverageTone(connection)} />
            </dd>
          </div>
          <div>
            <dt>Monitoring</dt>
            <dd>
              <HealthPill
                label={snapshot.coverage.monitoring === 'armed' ? 'Armed' : 'Off'}
                tone={healthy ? 'healthy' : 'neutral'}
              />
            </dd>
          </div>
          <div>
            <dt>Last confirmed</dt>
            <dd className="health-grid__time">{lastConfirmed}</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>
              <HealthPill
                label={snapshot.storage.persistent ? 'Persistent' : 'Best effort'}
                tone={
                  snapshot.storage.fault
                    ? 'danger'
                    : snapshot.storage.persistent
                      ? 'healthy'
                      : 'warning'
                }
              />
            </dd>
          </div>
          <div>
            <dt>Audio</dt>
            <dd>
              <HealthPill
                label={alertLabels[snapshot.alerts.audio]}
                tone={alertTone(snapshot.alerts.audio)}
              />
            </dd>
          </div>
          <div>
            <dt>Notifications</dt>
            <dd>
              <HealthPill
                label={alertLabels[snapshot.alerts.notifications]}
                tone={alertTone(snapshot.alerts.notifications)}
              />
            </dd>
          </div>
          <div>
            <dt>Webhook</dt>
            <dd>
              <HealthPill
                label={alertLabels[snapshot.alerts.webhook]}
                tone={alertTone(snapshot.alerts.webhook)}
              />
            </dd>
          </div>
        </dl>
      </section>

      {snapshot.session.state === 'interrupted' ? (
        <section
          className="session-prompt"
          role="alertdialog"
          aria-labelledby="session-prompt-title"
        >
          <strong id="session-prompt-title">Interrupted session found</strong>
          <span>
            A session started {new Date(snapshot.session.startedAt ?? 0).toLocaleString()} is still
            open. Continue it to keep the work you had acknowledged, or start fresh. Nothing is
            alerted on until you choose, and monitoring stays off either way.
          </span>
          <div className="session-prompt__actions">
            <button type="button" onClick={() => void controller?.continueInterruptedSession()}>
              Continue session
            </button>
            <button
              className="button-secondary"
              type="button"
              onClick={() => void controller?.startNewSession()}
            >
              Start new session
            </button>
          </div>
        </section>
      ) : null}

      {snapshot.session.notice ? (
        <section className="session-notice" role="status">
          <strong>Previous session archived</strong>
          <span>{snapshot.session.notice}</span>
        </section>
      ) : null}

      {snapshot.error ||
      snapshot.coverage.fault ||
      snapshot.storage.fault ||
      snapshot.alerts.audio === 'fault' ||
      snapshot.alerts.notifications === 'fault' ||
      snapshot.alerts.webhook === 'fault' ||
      snapshot.crypto.state === 'fault' ||
      snapshot.phase === 'blocked' ? (
        <section className="fault-banner" role="alert">
          <strong>
            {snapshot.phase === 'blocked' ? 'Account already open' : 'Coverage needs attention'}
          </strong>
          <span>
            {snapshot.error ??
              snapshot.coverage.fault ??
              snapshot.storage.fault ??
              snapshot.alerts.audioDetail ??
              snapshot.alerts.notificationDetail ??
              snapshot.alerts.webhookDetail ??
              snapshot.crypto.detail}
          </span>
          {snapshot.coverage.connection === 'coverage_incomplete' ? (
            <button type="button" onClick={() => void controller?.retryCoverage()}>
              Retry recovery
            </button>
          ) : null}
        </section>
      ) : null}

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__copy">
            <p className="eyebrow">Coverage you can trust</p>
            <h1 id="hero-title">
              Important messages,
              <br />
              watched until done.
            </h1>
            <p className="hero__lede">
              AckWatch turns incoming Matrix activity into a durable attention queue—without
              pretending the browser can watch while it is closed.
            </p>

            {!isSignedIn && snapshot.phase !== 'blocked' ? (
              <LoginPanel snapshot={snapshot} controller={controller} />
            ) : (
              <section className="session-card" aria-labelledby="session-heading">
                <div>
                  <p className="eyebrow">Session control</p>
                  <h2 id="session-heading">
                    {snapshot.phase === 'blocked'
                      ? 'Second tab blocked'
                      : snapshot.coverage.monitoring === 'armed'
                        ? 'Monitoring is armed'
                        : connection === 'ready'
                          ? 'Ready when you are'
                          : 'Establishing coverage'}
                  </h2>
                  <p>
                    {connection === 'ready'
                      ? 'Network baseline confirmed and the ingestion queue is clear.'
                      : connection === 'coverage_incomplete'
                        ? 'Retry recovery before treating this monitoring interval as complete.'
                        : snapshot.coverage.monitoring === 'armed'
                          ? 'Monitoring intent is retained, but coverage is temporarily degraded.'
                          : 'Start remains unavailable until a fresh network sync is fully processed.'}
                  </p>
                </div>
                {snapshot.phase !== 'blocked' ? (
                  <button
                    className={snapshot.coverage.monitoring === 'armed' ? 'button-secondary' : ''}
                    type="button"
                    disabled={
                      snapshot.coverage.monitoring === 'off' &&
                      snapshot.coverage.connection !== 'ready'
                    }
                    onClick={() =>
                      snapshot.coverage.monitoring === 'armed'
                        ? controller?.stopMonitoring()
                        : controller?.startMonitoring()
                    }
                  >
                    {snapshot.coverage.monitoring === 'armed'
                      ? 'Stop monitoring'
                      : 'Start monitoring'}
                  </button>
                ) : null}
                {snapshot.phase !== 'blocked' && snapshot.session.state === 'active' ? (
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => void controller?.endSession()}
                  >
                    End session
                  </button>
                ) : null}
              </section>
            )}
          </div>

          <aside className="promise-card" aria-label="How AckWatch works">
            <div className="promise-card__signal" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <p className="eyebrow">The promise</p>
            <ol>
              <li>
                <span>01</span>
                <p>
                  <strong>Confirm the baseline</strong>
                  <small>Historical noise stays out of your queue.</small>
                </p>
              </li>
              <li>
                <span>02</span>
                <p>
                  <strong>Arm intentionally</strong>
                  <small>You decide exactly when coverage starts.</small>
                </p>
              </li>
              <li>
                <span>03</span>
                <p>
                  <strong>Recover honestly</strong>
                  <small>A failed gap can never look healthy.</small>
                </p>
              </li>
            </ol>
          </aside>
        </section>

        <section
          className="queue-preview workflow-board"
          aria-labelledby="workflow-heading"
          data-last-processed-event-id={lastProcessedEventId}
        >
          <header className="workflow-board__heading">
            <div>
              <p className="eyebrow">Durable workflow</p>
              <h2 id="workflow-heading">Attention queue</h2>
            </div>
            <p aria-live="polite">
              {snapshot.queueItems.length === 0
                ? healthy
                  ? 'Coverage is healthy. New qualifying activity will appear here.'
                  : 'Arm monitoring after the network baseline to accept new work.'
                : `${attentionItems.length} need attention · ${openItems.length} open · ${completedItems.length} completed`}
            </p>
          </header>
          <div className="workflow-columns">
            <QueueSection
              title="Needs attention"
              empty="No unseen or reopened work."
              items={attentionItems}
              activities={snapshot.queueActivities}
              controller={controller}
              openDetails={openDetails}
            />
            <QueueSection
              title="Open work"
              empty="Viewed and acknowledged work appears here."
              items={openItems}
              activities={snapshot.queueActivities}
              controller={controller}
              openDetails={openDetails}
            />
            <QueueSection
              title="Completed history"
              empty="Completed work remains here until explicit cleanup."
              items={completedItems}
              activities={snapshot.queueActivities}
              controller={controller}
              openDetails={openDetails}
            />
          </div>
        </section>

        {isSignedIn ? <CryptoSecurityPanel snapshot={snapshot} controller={controller} /> : null}

        {isSignedIn ? <AlertSettingsPanel snapshot={snapshot} controller={controller} /> : null}

        {isSignedIn ? (
          <section className="storage-card" aria-labelledby="storage-heading">
            <div>
              <p className="eyebrow">Local durability</p>
              <h2 id="storage-heading">
                {snapshot.storage.persistent
                  ? 'Persistent local storage enabled'
                  : 'Reduce browser eviction risk'}
              </h2>
              <p>
                Your queue is stored locally in IndexedDB. Browser storage is not a confidentiality
                boundary and can still be cleared explicitly.
              </p>
            </div>
            <div className="storage-card__actions">
              {snapshot.storage.persistenceSupported && !snapshot.storage.persistent ? (
                <button type="button" onClick={() => void controller?.requestPersistentStorage()}>
                  Request persistent storage
                </button>
              ) : null}
              <details>
                <summary>Settings export/import</summary>
                <label htmlFor="settings-transfer">Settings JSON</label>
                <textarea
                  id="settings-transfer"
                  value={settingsTransfer}
                  onChange={(event) => setSettingsTransfer(event.target.value)}
                  rows={5}
                />
                <div>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => {
                      void controller?.exportSettings().then((value) => {
                        if (value) setSettingsTransfer(value);
                        setSettingsStatus(
                          value ? 'Settings prepared for copy.' : 'No settings available.',
                        );
                      });
                    }}
                  >
                    Export settings
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!settingsTransfer}
                    onClick={() => {
                      void controller?.importSettings(settingsTransfer).then(
                        () => setSettingsStatus('Settings imported.'),
                        () => setSettingsStatus('Settings import failed validation.'),
                      );
                    }}
                  >
                    Import settings
                  </button>
                </div>
                <p aria-live="polite">{settingsStatus}</p>
              </details>
            </div>
          </section>
        ) : null}
      </main>

      {selectedItem ? (
        <ItemDetail
          key={selectedItem.id}
          item={selectedItem}
          activities={snapshot.queueActivities}
          controller={controller}
          close={() => setSelectedItemId(undefined)}
        />
      ) : null}

      <footer>
        <p>Independent open-source software. Not endorsed by The Matrix.org Foundation.</p>
        <p>Local-first · No telemetry · Apache-2.0</p>
      </footer>
    </div>
  );
}
