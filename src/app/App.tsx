import { type FormEvent, useMemo, useState, useSyncExternalStore } from 'react';

import type { AckWatchControllerPort, AppSnapshot } from '../application/app-controller';
import type { FoundationViewModel } from './view-model';
import { signedOutView } from './view-model';

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
        </dl>
      </section>

      {snapshot.error || snapshot.coverage.fault || snapshot.phase === 'blocked' ? (
        <section className="fault-banner" role="alert">
          <strong>
            {snapshot.phase === 'blocked' ? 'Account already open' : 'Coverage needs attention'}
          </strong>
          <span>{snapshot.error ?? snapshot.coverage.fault}</span>
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
          className="queue-preview"
          aria-labelledby="queue-heading"
          data-last-processed-event-id={lastProcessedEventId}
        >
          <div>
            <p className="eyebrow">Developer event ledger</p>
            <h2 id="queue-heading">
              {snapshot.activities.length === 0
                ? 'Nothing needs attention'
                : `${snapshot.activities.length} captured event${snapshot.activities.length === 1 ? '' : 's'}`}
            </h2>
          </div>
          {snapshot.activities.length === 0 ? (
            <p>
              {healthy
                ? 'Coverage is healthy. New qualifying activity will appear here.'
                : 'Only live external activity delivered during an armed session is eligible.'}
            </p>
          ) : (
            <ol className="event-ledger" aria-label="Captured Matrix events">
              {snapshot.activities.map((activity) => (
                <li key={activity.eventId} data-event-id={activity.eventId}>
                  <div>
                    <strong>{activity.roomName ?? activity.roomId}</strong>
                    <span>{activity.sender}</span>
                  </div>
                  <p>{activity.preview || activity.messageType}</p>
                  <code>{activity.eventId}</code>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>

      <footer>
        <p>Independent open-source software. Not endorsed by The Matrix.org Foundation.</p>
        <p>Local-first · No telemetry · Apache-2.0</p>
      </footer>
    </div>
  );
}
