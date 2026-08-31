import { useEffect } from 'react';

import type { AppSnapshot } from '../../application/app-controller';
import { App } from '../../app/App';

const baseCoverage: AppSnapshot['coverage'] = {
  connection: 'ready',
  monitoring: 'off',
  networkBaselineConfirmed: true,
  ingestionPending: 0,
  openGapCount: 0,
  lastConfirmedAt: Date.UTC(2026, 7, 31, 13, 41),
};

const signedOut: AppSnapshot = {
  phase: 'signed_out',
  accountLabel: 'Not signed in',
  coverage: {
    connection: 'signed_out',
    monitoring: 'off',
    networkBaselineConfirmed: false,
    ingestionPending: 0,
    openGapCount: 0,
  },
  activities: [],
  ingestionIssues: [],
  ingestionDecisions: [],
};

const active = (coverage: Partial<AppSnapshot['coverage']> = {}): AppSnapshot => ({
  phase: 'active',
  accountLabel: '@operator:example.test',
  homeserverLabel: 'https://matrix.example.test',
  coverage: { ...baseCoverage, ...coverage },
  activities: [],
  ingestionIssues: [],
  ingestionDecisions: [],
});

const fixtures = {
  armed: active({ monitoring: 'armed' }),
  baseline: {
    ...active(),
    coverage: {
      connection: 'baseline_syncing',
      monitoring: 'off',
      networkBaselineConfirmed: false,
      ingestionPending: 0,
      openGapCount: 0,
    },
  },
  incomplete: {
    ...active({ connection: 'coverage_incomplete', monitoring: 'armed', openGapCount: 1 }),
    error: 'Gap pagination ended before the known boundary. Retry remains available.',
  },
  ready: active(),
  received: {
    ...active({ monitoring: 'armed' }),
    activities: [
      {
        kind: 'activity',
        accountId: '@operator:example.test|https://matrix.example.test',
        eventId: '$synthetic-event:example.test',
        roomId: '!operations:example.test',
        roomName: 'Operations desk',
        sender: '@dispatch:example.test',
        eventType: 'm.room.message',
        messageType: 'm.text',
        preview: 'Service check requires review before the next handoff.',
        detectedAt: Date.UTC(2026, 7, 31, 13, 42),
        localSequence: 1,
        provenance: 'live',
      },
    ],
  },
  reconnecting: active({ connection: 'reconnecting', monitoring: 'armed' }),
  recovering: active({ connection: 'recovering_gap', monitoring: 'armed', openGapCount: 1 }),
  'second-tab': {
    ...active(),
    phase: 'blocked',
    error: 'Another AckWatch tab owns this Matrix account session.',
  },
  'signed-out': signedOut,
} satisfies Record<string, AppSnapshot>;

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

  return <App snapshot={fixtures[state]} />;
}
