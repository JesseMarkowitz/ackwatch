import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { AckWatchController } from './application/app-controller';
import './app/app.css';

const rootElement = document.querySelector('#root');

if (!rootElement) {
  throw new Error('AckWatch root element is missing.');
}

const root = createRoot(rootElement);

if (import.meta.env.MODE === 'catalog') {
  const { StateCatalog } = await import('./testing/catalog/StateCatalog');
  root.render(
    <StrictMode>
      <StateCatalog />
    </StrictMode>,
  );
} else {
  const controller = new AckWatchController();
  void controller.initialize();
  window.addEventListener('pagehide', () => void controller.teardown(), { once: true });
  root.render(
    <StrictMode>
      <App controller={controller} />
    </StrictMode>,
  );
}
