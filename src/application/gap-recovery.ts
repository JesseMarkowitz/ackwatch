import type { CoverageMachine } from '../domain/coverage';
import type { IngestionEnvelope, RawMatrixEvent } from '../domain/ingestion';

export interface GapPage {
  /** Matrix `dir=b` order: newest to oldest. */
  readonly chunk: readonly RawMatrixEvent[];
  readonly end?: string;
}

export interface GapRecoverySource {
  fetchBackward(roomId: string, from: string, limit: number): Promise<GapPage>;
}

interface ActiveGap {
  readonly accountId: string;
  readonly roomId: string;
  readonly boundaryEventId: string;
  readonly detectedAt: number;
  paginationToken: string;
  readonly buffered: IngestionEnvelope[];
}

export type GapRecoveryResult =
  | { readonly status: 'complete'; readonly emitted: number }
  | { readonly status: 'incomplete'; readonly detail: string };

export class GapRecoveryCoordinator {
  private readonly active = new Map<string, ActiveGap>();

  public constructor(
    private readonly coverage: CoverageMachine,
    private readonly emit: (envelope: IngestionEnvelope) => void,
    private readonly pageLimit = 100,
    private readonly maxPages = 100,
  ) {}

  public begin(
    accountId: string,
    roomId: string,
    boundaryEventId: string,
    paginationToken: string | null,
    detectedAt: number,
    coverageAlreadyStarted = false,
    persistedRetry = false,
  ): boolean {
    if (!persistedRetry && !this.coverage.isEligibleForNewWork()) return false;
    if (!coverageAlreadyStarted) this.coverage.beginGap(roomId);

    if (!paginationToken) {
      this.coverage.failGap(roomId, 'The limited timeline did not provide a recovery token.');
      return false;
    }

    this.active.set(roomId, {
      accountId,
      roomId,
      boundaryEventId,
      paginationToken,
      detectedAt,
      buffered: [],
    });
    return true;
  }

  public bufferIfRecovering(envelope: IngestionEnvelope): boolean {
    const roomId = envelope.event.roomId;
    if (!roomId) return false;
    const gap = this.active.get(roomId);
    if (!gap) return false;
    gap.buffered.push(envelope);
    return true;
  }

  public async recover(roomId: string, source: GapRecoverySource): Promise<GapRecoveryResult> {
    const gap = this.active.get(roomId);
    if (!gap) return { status: 'incomplete', detail: 'No active gap recovery exists.' };

    const newestToOldest: RawMatrixEvent[] = [];
    let token = gap.paginationToken;

    try {
      for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
        const page = await source.fetchBackward(roomId, token, this.pageLimit);
        const boundaryIndex = page.chunk.findIndex(
          (event) => event.eventId === gap.boundaryEventId,
        );

        if (boundaryIndex >= 0) {
          newestToOldest.push(...page.chunk.slice(0, boundaryIndex));
          const recovered = [...newestToOldest].reverse();
          for (const event of recovered) {
            this.emit({
              accountId: gap.accountId,
              event,
              provenance: 'gap_recovery',
              localSequence: 0,
              detectedAt: gap.detectedAt,
              eligibleAtDelivery: true,
            });
          }
          for (const envelope of gap.buffered) this.emit(envelope);
          this.active.delete(roomId);
          this.coverage.completeGap(roomId);
          return { status: 'complete', emitted: recovered.length + gap.buffered.length };
        }

        newestToOldest.push(...page.chunk);
        if (!page.end || page.end === token || page.chunk.length === 0) {
          return this.markIncomplete(roomId, 'Gap pagination ended before the known boundary.');
        }
        token = page.end;
        gap.paginationToken = token;
      }
      return this.markIncomplete(roomId, 'Gap recovery exceeded the bounded page limit.');
    } catch (error: unknown) {
      return this.markIncomplete(
        roomId,
        error instanceof Error ? error.message : 'Gap recovery request failed.',
      );
    }
  }

  public activeRoomIds(): readonly string[] {
    return [...this.active.keys()];
  }

  private markIncomplete(roomId: string, detail: string): GapRecoveryResult {
    this.active.delete(roomId);
    this.coverage.failGap(roomId, detail);
    return { status: 'incomplete', detail };
  }
}
