import type { FoundationViewModel } from './view-model';
import { signedOutView } from './view-model';

interface AppProps {
  readonly view?: FoundationViewModel;
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

export function App({ view = signedOutView }: AppProps) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <Wordmark />
        <p className="topbar__descriptor">A local-first attention monitor for Matrix</p>
        <button className="icon-button" type="button" aria-label="Open settings" disabled>
          <span aria-hidden="true">•••</span>
        </button>
      </header>

      <section className="health-strip" aria-label="Monitoring health">
        <div className="health-strip__identity">
          <p className="eyebrow">Account</p>
          <p className="health-strip__account">{view.accountLabel}</p>
        </div>
        <dl className="health-grid">
          <div>
            <dt>Connection</dt>
            <dd>
              <HealthPill label={view.connectionLabel} tone={view.connectionTone} />
            </dd>
          </div>
          <div>
            <dt>Monitoring</dt>
            <dd>
              <HealthPill label={view.monitoringLabel} tone={view.monitoringTone} />
            </dd>
          </div>
          <div>
            <dt>Last confirmed</dt>
            <dd className="health-grid__time">{view.lastConfirmed}</dd>
          </div>
        </dl>
      </section>

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

            {!view.isSignedIn ? (
              <form className="connect-card" onSubmit={(event) => event.preventDefault()}>
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
                    aria-describedby="matrix-id-help"
                  />
                  <button type="submit">Continue</button>
                </div>
                <p id="matrix-id-help" className="field-help">
                  Your password and access token stay in this browser session and are never written
                  to AckWatch storage.
                </p>
              </form>
            ) : (
              <section className="session-card" aria-labelledby="session-heading">
                <div>
                  <p className="eyebrow">Session control</p>
                  <h2 id="session-heading">
                    {view.isMonitoring ? 'Monitoring is armed' : 'Ready when you are'}
                  </h2>
                  <p>{view.connectionDetail}</p>
                </div>
                <button className={view.isMonitoring ? 'button-secondary' : ''} type="button">
                  {view.isMonitoring ? 'Stop monitoring' : 'Start monitoring'}
                </button>
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
                  <strong>Finish the work</strong>
                  <small>Alerts continue until attention is resolved.</small>
                </p>
              </li>
            </ol>
          </aside>
        </section>

        <section className="queue-preview" aria-labelledby="queue-heading">
          <div>
            <p className="eyebrow">Attention queue</p>
            <h2 id="queue-heading">Nothing needs attention</h2>
          </div>
          <p>
            {view.isMonitoring
              ? 'Coverage is healthy. New qualifying activity will appear here.'
              : 'Connect and arm monitoring to begin a bounded coverage session.'}
          </p>
        </section>
      </main>

      <footer>
        <p>Independent open-source software. Not endorsed by The Matrix.org Foundation.</p>
        <p>Local-first · No telemetry · Apache-2.0</p>
      </footer>
    </div>
  );
}
