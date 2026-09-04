import {
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { AckWatchControllerPort, AppSnapshot } from '../application/app-controller';
import type { FoundationViewModel } from './view-model';
import { signedOutView } from './view-model';
import {
  compareByMostRecentlyCompleted,
  compareByOldestAcknowledged,
  compareByOldestDetected,
  matrixEventUri,
  type QueueActivity,
  type QueueItem,
} from '../domain/queue';
import type { EventDetail } from '../application/event-detail';
import { itemReference } from '../application/alert-dispatcher';

interface AppProps {
  readonly controller?: AckWatchControllerPort;
  readonly snapshot?: AppSnapshot;
  readonly view?: FoundationViewModel;
}

const noSubscription = () => () => undefined;

const timestampFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Absolute time, because an operator correlates a card against the room it came from. */
function formatTimestamp(value: number | undefined): string {
  return value === undefined ? 'Unknown time' : timestampFormat.format(value);
}

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
  if (state === 'untested') return 'neutral';
  if (state === 'retrying' || state === 'permission_required') return 'warning';
  if (state === 'fault') return 'danger';
  return 'neutral';
}

const alertLabels: Record<AppSnapshot['alerts']['audio'], string> = {
  disabled: 'Disabled',
  ready: 'Ready',
  permission_required: 'Needs setup',
  untested: 'Not tested',
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
  const [playingTone, setPlayingTone] = useState(false);
  // Reported beside the button that caused it: a shared status line put the answer under the
  // webhook section, where nobody testing audio would look.
  const [toneStatus, setToneStatus] = useState('');
  // Settings arrive from IndexedDB after this panel first renders, and `useState` only seeds on
  // that first render — so a saved webhook came back blank after every reload, and pressing save
  // from the blank form would have erased a working configuration. Re-seed when the stored value
  // changes; it only changes when a save succeeds.
  const storedEndpoint = settings?.webhookEndpoint;
  const storedTopic = settings?.webhookTopic;
  const [seeded, setSeeded] = useState({ endpoint: storedEndpoint, topic: storedTopic });
  if (seeded.endpoint !== storedEndpoint || seeded.topic !== storedTopic) {
    // Adjusted during render rather than in an effect, which is what React documents for syncing
    // state to a changed input: an effect would commit a render showing the stale blank fields
    // first, and the lint rule that forbids it is right.
    setSeeded({ endpoint: storedEndpoint, topic: storedTopic });
    setEndpoint(storedEndpoint ?? '');
    setTopic(storedTopic ?? '');
  }
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
        {/*
          Plays the real tone at the configured volume, inside the click that asked for it. The
          readiness indicator alone cannot answer "will I actually hear this": the unlock check
          plays the clip muted, and browsers allow muted playback unconditionally.
        */}
        <button
          type="button"
          className={`button-secondary${playingTone ? ' is-active' : ''}`}
          disabled={playingTone}
          onClick={() => {
            setPlayingTone(true);
            setToneStatus('Playing the alert tone…');
            const settled = controller?.sendTestAudio() ?? Promise.resolve();
            void Promise.all([
              settled.then(
                () => setToneStatus('Alert tone played at the configured volume.'),
                (error: unknown) =>
                  setToneStatus(
                    `Alert tone failed — ${error instanceof Error ? error.message : String(error)}`,
                  ),
              ),
              // Held long enough to be seen. The clip is a fraction of a second, so feedback tied
              // strictly to its duration would flicker and read as nothing happening.
              new Promise((resolve) => setTimeout(resolve, 600)),
            ]).finally(() => setPlayingTone(false));
          }}
        >
          {playingTone ? 'Playing…' : 'Test alert tone'}
        </button>
        <p className="alert-settings__status" aria-live="polite" role="status">
          {toneStatus}
        </p>
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
                  (error: unknown) =>
                    // Report what actually failed rather than the likeliest cause. A guessed
                    // explanation sends the reader somewhere else entirely when it is wrong.
                    setStatus(
                      `Test failed — ${error instanceof Error ? error.message : String(error)}`,
                    ),
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
        </details>
        <p className="alert-settings__status" aria-live="polite" role="status">
          {status}
        </p>
      </div>
    </section>
  );
}

/**
 * Exhausted deliveries, summarised rather than listed.
 *
 * One row per failure with its own retry button is fine for one failure and unusable for forty: a
 * misconfigured webhook fails identically every time, and the wall of rows buried the settings that
 * would fix it. Failures are grouped by the reason they share, retried together, and the individual
 * entries stay available behind a disclosure for when the reason is not the same.
 */
function ExhaustedDeliveries({
  deliveries,
  controller,
}: {
  readonly deliveries: NonNullable<AppSnapshot['alertDeliveries']>;
  readonly controller: AckWatchControllerPort | undefined;
}) {
  const [busy, setBusy] = useState(false);
  if (deliveries.length === 0) return null;

  const groups = new Map<string, { transport: string; reason: string; ids: string[] }>();
  for (const delivery of deliveries) {
    const reason = delivery.lastErrorCode ?? 'unknown failure';
    const key = `${delivery.transport}|${reason}`;
    const group = groups.get(key) ?? { transport: delivery.transport, reason, ids: [] };
    group.ids.push(delivery.id);
    groups.set(key, group);
  }

  const act = (ids: readonly string[], run: (id: string) => Promise<void> | undefined) => {
    setBusy(true);
    void Promise.allSettled(ids.map((id) => run(id))).finally(() => setBusy(false));
  };

  return (
    <section className="alert-retry-summary" aria-label="Alert deliveries needing a decision">
      <p className="alert-retry-summary__headline">
        {deliveries.length} {deliveries.length === 1 ? 'delivery' : 'deliveries'} exhausted their
        retries. Dismissing keeps the record and stops it asking for a decision; ending the session
        clears them all.
      </p>
      {[...groups.values()].map((group) => (
        <div className="alert-retry" key={`${group.transport}|${group.reason}`}>
          <span>
            {group.transport} · {group.reason}
            {group.ids.length > 1 ? ` · ${group.ids.length} deliveries` : ''}
          </span>
          {/*
            Audio is not offered a retry. A sound that was missed cannot be usefully played later,
            and replaying a backlog would fire the whole queue at once — twenty-five chimes in a row
            tells the operator nothing about twenty-five separate moments that have passed. The
            failure is still worth showing, so it can be dismissed instead.
          */}
          {group.transport === 'audio' ? null : (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => act(group.ids, (id) => controller?.retryAlertDelivery(id))}
            >
              {group.ids.length > 1 ? `Retry all ${group.ids.length}` : 'Retry delivery'}
            </button>
          )}
          <button
            type="button"
            className="button-secondary"
            disabled={busy}
            onClick={() => act(group.ids, (id) => controller?.dismissAlertDelivery(id))}
          >
            {group.ids.length > 1 ? `Dismiss ${group.ids.length}` : 'Dismiss'}
          </button>
        </div>
      ))}
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
          Set this up to read message text from <strong>encrypted rooms</strong>. Without it those
          items still appear in the queue and still alert you, but their content shows as an
          encrypted placeholder, because a new device holds no keys for history. Rooms that are not
          encrypted need nothing here. This is one-time setup per device, not a per-session step.
        </p>
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

function deadlineLabel(item: QueueItem): string {
  if (!item.deadline) return 'No active deadline';
  return `${item.deadline.kind === 'acknowledged' ? 'Pending-work' : 'Unacknowledged'} deadline ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(item.deadline.firstAt)}`;
}

const QueueCard = memo(function QueueCard({
  item,
  controller,
  openDetails,
}: {
  readonly item: QueueItem;
  readonly controller: AckWatchControllerPort | undefined;
  readonly openDetails: (itemId: string) => void;
}) {
  // Rendered from the item's own copy of its newest activity, so a card costs nothing to display
  // regardless of how many activities the session has accumulated.
  const latest = item.latestActivity;
  return (
    <article
      className={`queue-card ${item.needsAttention ? 'queue-card--attention' : ''}`}
      data-item-id={item.id}
      data-event-id={latest?.eventId}
      data-status={item.status}
    >
      <div className="queue-card__meta">
        <span>{latest?.roomName ?? item.roomId}</span>
        <span className="queue-card__reference" title="Reference used in external alerts">
          {itemReference(item.id)}
        </span>
        <span>
          {item.activityCount} activit{item.activityCount === 1 ? 'y' : 'ies'}
        </span>
      </div>
      <p className="queue-card__detected">
        Detected{' '}
        <time dateTime={new Date(item.firstDetectedAt).toISOString()}>
          {formatTimestamp(item.firstDetectedAt)}
        </time>
        {item.lastActivityAt !== item.firstDetectedAt
          ? ` · latest ${formatTimestamp(item.lastActivityAt)}`
          : ''}
      </p>
      <h3>{latest?.sender ?? 'Matrix activity'}</h3>
      <p>
        {latest?.preview ?? 'Detail is temporarily unavailable.'}
        {latest?.preview?.endsWith('…') ? (
          <span className="truncation-badge" title="Shortened; open details for the full message">
            shortened
          </span>
        ) : null}
      </p>
      <div className="queue-card__status">
        <strong>{item.needsAttention ? 'Needs attention' : item.status}</strong>
        <span>{deadlineLabel(item)}</span>
      </div>
      <div className="queue-card__actions">
        <button type="button" onClick={() => openDetails(item.id)}>
          View details
        </button>
        {/*
          Acknowledging used to require opening the item, which made the most common action on the
          board the only one that cost a dialog — and hid it well enough that an automated soak run
          completed twenty-one items without acknowledging any.
        */}
        {item.status === 'NEW' || item.status === 'UNACKNOWLEDGED' ? (
          <button
            type="button"
            className="button-secondary"
            onClick={() => void controller?.applyQueueCommand(item.id, 'acknowledge')}
          >
            Acknowledge
          </button>
        ) : null}
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
});

/**
 * Ephemeral filter over completed history: set while looking, gone when the tab closes.
 *
 * Not persisted deliberately — it narrows what you are reading right now, and a saved filter would
 * silently hide history the next time the app opened, which is the worst failure available to a
 * record you consult to find something.
 *
 * Search covers what AckWatch actually holds: the item reference printed on alerts, the sender, the
 * room name, and the stored preview. The preview is bounded to 160 characters (ADR-0005), so text
 * past that point is not searchable here — the limitation is stated in the placeholder rather than
 * left to be discovered by a search that quietly finds nothing.
 */
function matchesQuery(item: QueueItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const latest = item.latestActivity;
  return [
    itemReference(item.id),
    latest?.sender,
    latest?.roomName,
    item.roomId,
    latest?.preview,
  ].some((field) => field?.toLowerCase().includes(needle));
}

function QueueSection({
  title,
  empty,
  items,
  controller,
  openDetails,
  searchable = false,
}: {
  readonly title: string;
  readonly empty: string;
  readonly items: readonly QueueItem[];
  readonly controller: AckWatchControllerPort | undefined;
  readonly openDetails: (itemId: string) => void;
  readonly searchable?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(25);
  const slug = title.replaceAll(' ', '-').toLowerCase();
  const matched = searchable ? items.filter((item) => matchesQuery(item, query)) : items;
  const shown = searchable ? matched.slice(0, limit) : matched;

  return (
    <section className="queue-column" aria-labelledby={`queue-${slug}`}>
      <header>
        <h2 id={`queue-${slug}`}>{title}</h2>
        <span aria-label={`${items.length} items`}>{items.length}</span>
      </header>
      {searchable ? (
        <div className="queue-filter">
          <label className="visually-hidden" htmlFor={`filter-${slug}`}>
            Search {title}
          </label>
          <input
            id={`filter-${slug}`}
            type="search"
            value={query}
            placeholder="Reference, sender, room, or preview text"
            onChange={(event) => setQuery(event.target.value)}
          />
          <label htmlFor={`limit-${slug}`}>Show</label>
          <select
            id={`limit-${slug}`}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          >
            {[10, 25, 50, 100].map((value) => (
              <option key={value} value={value}>
                last {value}
              </option>
            ))}
          </select>
          <span className="queue-filter__count">
            {matched.length === items.length
              ? `${shown.length} of ${items.length}`
              : `${shown.length} of ${matched.length} matching · ${items.length} total`}
          </span>
        </div>
      ) : null}
      {shown.length === 0 ? (
        <p className="queue-column__empty">
          {items.length === 0 ? empty : 'Nothing matches that search.'}
        </p>
      ) : (
        <div className="queue-column__items">
          {shown.map((item) => (
            <QueueCard
              key={item.id}
              item={item}
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
  controller,
  close,
}: {
  readonly item: QueueItem;
  readonly controller: AckWatchControllerPort | undefined;
  readonly close: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Only the opened item's activities are read, by index, rather than the whole account.
  const [itemActivities, setItemActivities] = useState<readonly QueueActivity[]>([]);
  useEffect(() => {
    let active = true;
    void controller?.loadItemActivities(item.id).then((loaded) => {
      if (active) setItemActivities(loaded);
    });
    return () => {
      active = false;
    };
  }, [controller, item.id]);
  const latest = itemActivities.at(-1);
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
            <dt>Detected</dt>
            <dd>
              <time dateTime={new Date(item.firstDetectedAt).toISOString()}>
                {formatTimestamp(item.firstDetectedAt)}
              </time>
            </dd>
          </div>
          <div>
            <dt>Latest here</dt>
            <dd>
              <time dateTime={new Date(item.lastActivityAt).toISOString()}>
                {formatTimestamp(item.lastActivityAt)}
              </time>
            </dd>
          </div>
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
            <dt>Sent</dt>
            <dd>
              {resolvedDetail?.availability === 'available' ? (
                <time dateTime={new Date(resolvedDetail.originServerTs).toISOString()}>
                  {formatTimestamp(resolvedDetail.originServerTs)}
                </time>
              ) : (
                'Unavailable until detail resolves'
              )}
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
          {resolvedDetail?.availability === 'available' ? null : (
            <p className="truncation-note" role="status">
              Showing the stored preview
              {latest?.preview?.endsWith('…') ? ', which is shortened' : ''}. The full message could
              not be resolved from the Matrix client.
            </p>
          )}
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
          <>
            <p className="field-help">
              Earlier messages are shown as stored previews, bounded to 160 characters so that
              little plaintext rests on this device. The newest message is shown in full above,
              resolved from the Matrix client on demand.
            </p>
            <ol className="detail-activity-list" aria-label="Item activity history">
              {itemActivities.map((activity) => (
                <li key={activity.id}>
                  <div>
                    <strong>{activity.sender}</strong>
                    <span>{activity.relationKind}</span>
                    <time
                      className="detail-activity-list__time"
                      dateTime={new Date(activity.detectedAt).toISOString()}
                    >
                      {formatTimestamp(activity.detectedAt)}
                    </time>
                  </div>
                  <p>
                    {activity.preview}
                    {activity.preview.endsWith('…') ? (
                      <span className="truncation-badge">shortened</span>
                    ) : null}
                  </p>
                </li>
              ))}
            </ol>
          </>
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

function AboutPanel({ close }: { readonly close: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close]);

  return (
    <div className="detail-backdrop">
      <section
        ref={panel}
        className="detail-panel about-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        tabIndex={-1}
      >
        <div className="detail-panel__header">
          <div>
            <p className="eyebrow">About</p>
            <h2 id="about-title">AckWatch</h2>
          </div>
          <button type="button" className="button-secondary" onClick={close}>
            Close
          </button>
        </div>
        <p>
          AckWatch watches the Matrix rooms you supervise during a working session and turns
          activity that needs a response into a queue item, which stays visible until you
          acknowledge and complete it.
        </p>
        <p>
          Everything it knows lives in this browser. There is no AckWatch server, no account, and no
          telemetry. Your Matrix password is held for the session only and never stored.
        </p>
        <p>
          It monitors only while this page is open, and it never claims otherwise: close the tab and
          monitoring stops. It starts only when you arm it, and never resumes by itself after a
          reload, so coverage is always something you chose rather than something assumed.
        </p>
        <dl className="about-facts">
          <div>
            <dt>Version</dt>
            <dd>{__ACKWATCH_VERSION__}</dd>
          </div>
          <div>
            <dt>License</dt>
            <dd>Apache 2.0</dd>
          </div>
        </dl>
        <p className="field-help">
          Independent open-source project, not endorsed by The Matrix.org Foundation or Element.
        </p>
      </section>
    </div>
  );
}

/**
 * Which of the four startup phases the client is in, and what to call it.
 *
 * Deliberately not a percentage. Matrix never tells a client how much of an initial sync is left,
 * so any "60%" would be invented and would stall at whatever number the fiction reached. These are
 * phases the client genuinely passes through, in order, and the fourth is the one that matters:
 * only then can monitoring be armed.
 */
function startupStage(snapshot: AppSnapshot): { readonly step: number; readonly label: string } {
  switch (snapshot.coverage.connection) {
    case 'starting':
      return { step: 1, label: 'Restoring local data' };
    case 'cache_restored':
      return {
        step: 2,
        label:
          snapshot.crypto.state === 'initializing' ? 'Preparing encryption' : 'Local data ready',
      };
    case 'baseline_syncing':
      return { step: 3, label: 'Confirming coverage' };
    case 'ready':
      return { step: 4, label: 'Ready' };
    default:
      // Reconnecting, catching up, recovering a gap: no longer starting up, so the coverage label
      // is the honest thing to show rather than a step in a sequence already completed.
      return { step: 0, label: coverageLabels[snapshot.coverage.connection] };
  }
}

/**
 * Session state and its controls, carried in the top bar.
 *
 * It lives beside the wordmark rather than in a panel of its own because it is a status line, not
 * a section: one short phrase and the two buttons that act on it.
 */
function SessionBar({
  snapshot,
  controller,
}: {
  readonly snapshot: AppSnapshot;
  readonly controller: AckWatchControllerPort | undefined;
}) {
  const blocked = snapshot.phase === 'blocked';
  const armed = snapshot.coverage.monitoring === 'armed';
  const stage = startupStage(snapshot);
  const status = blocked
    ? 'Second tab blocked'
    : armed
      ? 'Monitoring armed'
      : stage.step === 4
        ? 'Ready'
        : stage.step === 0
          ? stage.label
          : `Step ${stage.step} of 4 · ${stage.label}`;
  const tone = blocked
    ? 'danger'
    : armed || stage.step === 4
      ? 'healthy'
      : coverageTone(snapshot.coverage.connection);

  return (
    <div className="session-bar">
      <span
        className={`session-bar__status session-bar__status--${tone}`}
        role="status"
        title={
          stage.step === 3
            ? 'A first sign-in reads every room you have joined, so this is the slow phase. Nothing is missed while it runs: monitoring only starts once you arm it.'
            : undefined
        }
      >
        {status}
      </span>
      {blocked ? null : (
        <button
          className={`session-bar__button${armed ? ' button-secondary' : ''}`}
          type="button"
          disabled={!armed && snapshot.coverage.connection !== 'ready'}
          onClick={() => (armed ? controller?.stopMonitoring() : controller?.startMonitoring())}
        >
          {armed ? 'Stop monitoring' : 'Start monitoring'}
        </button>
      )}
      {!blocked && snapshot.session.state === 'active' ? (
        <button
          className="session-bar__button button-secondary"
          type="button"
          onClick={() => void controller?.endSession()}
        >
          End session
        </button>
      ) : null}
    </div>
  );
}

/**
 * Configuration, kept off the board.
 *
 * Everything here is set once or occasionally — alert delivery, device durability, encryption keys,
 * data export — and none of it is work that arrived thirty seconds ago. Sharing a page with the
 * queue meant a one-time decision competed for attention with the thing the product exists to show.
 *
 * Deliberately excluded: exhausted alert deliveries, which look like configuration and are not.
 * A failed delivery is a decision waiting on the operator, so it stays on the board.
 */
function SettingsView({
  snapshot,
  controller,
  close,
}: {
  readonly snapshot: AppSnapshot;
  readonly controller: AckWatchControllerPort | undefined;
  readonly close: () => void;
}) {
  const [settingsTransfer, setSettingsTransfer] = useState('');
  // The transfer box is shared between settings and diagnostics, so it tracks which it is holding.
  const [transferKind, setTransferKind] = useState<'settings' | 'diagnostics'>('settings');
  const [settingsStatus, setSettingsStatus] = useState('');
  // Clearing is irreversible, so the control asks a second time rather than acting on one click.
  const [clearArmed, setClearArmed] = useState(false);

  return (
    <main className="settings-view">
      <div className="settings-view__header">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Alerts, this device, and your data</h1>
        </div>
        <button type="button" className="topbar__about" onClick={close}>
          Back to the board
        </button>
      </div>
      <CryptoSecurityPanel snapshot={snapshot} controller={controller} />

      <AlertSettingsPanel snapshot={snapshot} controller={controller} />

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
          <p className="field-help">
            <strong>Clear stored data</strong> erases everything this account holds on this device —
            queue items and their activity history, alert effects, deliveries and attempts,
            monitoring sessions, ingestion issues, quarantined records, <em>and your settings</em>,
            including the webhook configuration. It does not touch anything on Matrix. Ending a
            session clears the work but keeps your settings; this does not. Export first if you want
            to restore them.
          </p>
          <details>
            <summary>Settings export/import</summary>
            <label htmlFor="settings-transfer">
              {transferKind === 'diagnostics'
                ? 'Diagnostics report (read-only; replace it with settings JSON to import)'
                : 'Settings JSON'}
            </label>
            <textarea
              id="settings-transfer"
              value={settingsTransfer}
              onChange={(event) => {
                setSettingsTransfer(event.target.value);
                setTransferKind('settings');
              }}
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
          <details>
            <summary>Diagnostics and cleanup</summary>
            <p className="storage-card__note">
              A diagnostics report describes how this installation is behaving using counts, codes
              and timings only. It carries no message text, room or event identifiers, senders, or
              webhook destination, so it is safe to attach to a bug report.
            </p>
            <div>
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  void controller?.exportDiagnostics().then((value) => {
                    if (value) {
                      setSettingsTransfer(value);
                      setTransferKind('diagnostics');
                    }
                    setSettingsStatus(
                      value ? 'Diagnostics report prepared for copy.' : 'No diagnostics available.',
                    );
                  });
                }}
              >
                Export diagnostics
              </button>
              <button
                type="button"
                className="button-danger"
                onClick={() => {
                  if (clearArmed) {
                    void controller?.clearStoredData().then(() => {
                      setClearArmed(false);
                      setSettingsStatus('Stored data for this account was cleared.');
                    });
                    return;
                  }
                  setClearArmed(true);
                  setSettingsStatus(
                    'This permanently deletes this account\u2019s queue, history and settings. Press again to confirm.',
                  );
                }}
              >
                {clearArmed ? 'Confirm clear' : 'Clear stored data'}
              </button>
            </div>
          </details>
        </div>
      </section>
    </main>
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
  const [aboutOpen, setAboutOpen] = useState(false);
  // A hash route rather than a toggle, so the back button leaves settings and a link can point at
  // them. The app is a static bundle, so a path-based router would need server rewrites.
  const [onSettings, setOnSettings] = useState(() => globalThis.location?.hash === '#/settings');
  useEffect(() => {
    const sync = () => setOnSettings(globalThis.location?.hash === '#/settings');
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const selectedItem = snapshot.queueItems.find(({ id }) => id === selectedItemId);
  const attentionItems = snapshot.queueItems
    .filter((item) => item.status !== 'COMPLETED' && item.needsAttention)
    .sort(compareByOldestDetected);
  const openItems = snapshot.queueItems
    .filter((item) => item.status !== 'COMPLETED' && !item.needsAttention)
    .sort(compareByOldestAcknowledged);
  const completedItems = snapshot.queueItems
    .filter((item) => item.status === 'COMPLETED')
    .sort(compareByMostRecentlyCompleted);
  // Stable across renders, so a memoized card is not re-rendered by a fresh callback identity.
  // It reads the queue through the controller rather than closing over `snapshot`, because a
  // callback that captured the snapshot would either go stale or change identity every render.
  const openDetails = useCallback(
    (itemId: string) => {
      setSelectedItemId(itemId);
      const item = controller?.getSnapshot?.().queueItems.find(({ id }) => id === itemId);
      if (item?.status === 'NEW') void controller?.applyQueueCommand(itemId, 'mark_viewed');
    },
    [controller],
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <Wordmark />
        {isSignedIn ? <SessionBar snapshot={snapshot} controller={controller} /> : <span />}
        <div className="topbar__actions">
          {isSignedIn ? (
            <button
              className="topbar__about"
              type="button"
              onClick={() => {
                globalThis.location.hash = onSettings ? '' : '#/settings';
              }}
            >
              {onSettings ? 'Board' : 'Settings'}
            </button>
          ) : null}
          <button className="topbar__about" type="button" onClick={() => setAboutOpen(true)}>
            About
          </button>
          {isSignedIn ? (
            <button
              className="topbar__action"
              type="button"
              onClick={() => void controller?.logout()}
            >
              Sign out
            </button>
          ) : null}
        </div>
      </header>

      {isSignedIn && !onSettings ? (
        <ExhaustedDeliveries deliveries={snapshot.alertDeliveries ?? []} controller={controller} />
      ) : null}

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
            <dt>Session</dt>
            <dd className="health-grid__time health-grid__stack">
              <span>
                <span className="health-grid__label">Started</span>{' '}
                {snapshot.session.startedAt === undefined ? (
                  'None'
                ) : (
                  <time dateTime={new Date(snapshot.session.startedAt).toISOString()}>
                    {formatTimestamp(snapshot.session.startedAt)}
                  </time>
                )}
              </span>
              <span>
                <span className="health-grid__label">Confirmed</span> {lastConfirmed}
              </span>
            </dd>
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

      {onSettings && isSignedIn ? (
        <SettingsView
          snapshot={snapshot}
          controller={controller}
          close={() => {
            globalThis.location.hash = '';
          }}
        />
      ) : (
        <main>
          {!isSignedIn && snapshot.phase !== 'blocked' ? (
            <section className="hero" aria-label="Sign in">
              <div className="hero__copy">
                <LoginPanel snapshot={snapshot} controller={controller} />
              </div>
            </section>
          ) : null}

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
                controller={controller}
                openDetails={openDetails}
              />
              <QueueSection
                title="Open work"
                empty="Viewed and acknowledged work appears here."
                items={openItems}
                controller={controller}
                openDetails={openDetails}
              />
              <QueueSection
                title="Completed history"
                empty="Completed work remains here until explicit cleanup."
                items={completedItems}
                controller={controller}
                openDetails={openDetails}
                searchable
              />
            </div>
          </section>

          {/* Configuration lives on the settings route; this page is for work that needs attention. */}
        </main>
      )}

      {selectedItem ? (
        <ItemDetail
          key={selectedItem.id}
          item={selectedItem}
          controller={controller}
          close={() => setSelectedItemId(undefined)}
        />
      ) : null}

      {aboutOpen ? <AboutPanel close={() => setAboutOpen(false)} /> : null}
    </div>
  );
}
