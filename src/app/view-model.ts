export type CoverageTone = 'neutral' | 'ready' | 'healthy' | 'warning';

export interface FoundationViewModel {
  readonly accountLabel: string;
  readonly connectionLabel: string;
  readonly connectionDetail: string;
  readonly connectionTone: CoverageTone;
  readonly monitoringLabel: string;
  readonly monitoringTone: CoverageTone;
  readonly lastConfirmed: string;
  readonly isSignedIn: boolean;
  readonly isMonitoring: boolean;
}

export const signedOutView: FoundationViewModel = {
  accountLabel: 'Not signed in',
  connectionLabel: 'Signed out',
  connectionDetail: 'Connect a Matrix account to establish a fresh coverage baseline.',
  connectionTone: 'neutral',
  monitoringLabel: 'Off',
  monitoringTone: 'neutral',
  lastConfirmed: 'No coverage session yet',
  isSignedIn: false,
  isMonitoring: false,
};

export const readyView: FoundationViewModel = {
  accountLabel: '@operator:example.test',
  connectionLabel: 'Ready',
  connectionDetail: 'Network baseline confirmed. Monitoring can be started.',
  connectionTone: 'ready',
  monitoringLabel: 'Off',
  monitoringTone: 'neutral',
  lastConfirmed: 'Today, 09:41',
  isSignedIn: true,
  isMonitoring: false,
};

export const armedView: FoundationViewModel = {
  accountLabel: '@operator:example.test',
  connectionLabel: 'Coverage complete',
  connectionDetail: 'All joined rooms are current and the ingestion queue is clear.',
  connectionTone: 'healthy',
  monitoringLabel: 'Armed',
  monitoringTone: 'healthy',
  lastConfirmed: 'A few seconds ago',
  isSignedIn: true,
  isMonitoring: true,
};
