import type { SafeMediaMetadata } from '../domain/queue';

export type EventDetail =
  | {
      readonly availability: 'available';
      readonly eventId: string;
      readonly roomId: string;
      readonly roomName: string;
      readonly sender: string;
      readonly originServerTs: number;
      readonly eventType: string;
      readonly messageType: string;
      readonly body: string;
      readonly relationKind: 'independent' | 'thread' | 'reply';
      readonly relationEventId?: string;
      readonly encrypted: boolean;
      readonly edited: boolean;
      readonly redacted: boolean;
      readonly media?: SafeMediaMetadata;
    }
  | {
      readonly availability: 'unavailable';
      readonly eventId: string;
      readonly roomId: string;
      readonly reason: 'client_unavailable' | 'event_not_loaded' | 'decryption_failed';
      readonly detail: string;
      readonly decryptionFailureCode?: string;
    };
