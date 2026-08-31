import { App } from '../../app/App';
import { armedView, readyView, signedOutView } from '../../app/view-model';
import { useEffect } from 'react';

const fixtures = {
  armed: armedView,
  ready: readyView,
  'signed-out': signedOutView,
} as const;

export type CatalogState = keyof typeof fixtures;

function isCatalogState(value: string | null): value is CatalogState {
  return value !== null && Object.hasOwn(fixtures, value);
}

export function StateCatalog() {
  const requestedState = new URLSearchParams(window.location.search).get('state');
  const state = isCatalogState(requestedState) ? requestedState : 'signed-out';

  useEffect(() => {
    document.documentElement.dataset.catalogState = state;
  }, [state]);

  return <App view={fixtures[state]} />;
}
