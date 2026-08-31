import type { CoverageMachine } from '../domain/coverage';
import {
  type DeveloperLedger,
  type IngestionEnvelope,
  type IngestionIssue,
  normalizeEnvelope,
} from '../domain/ingestion';

export class SerialIngestion {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  public constructor(
    private readonly ownUserId: string,
    private readonly coverage: CoverageMachine,
    private readonly ledger: DeveloperLedger,
    private readonly onChange: () => void,
  ) {}

  /** Non-throwing SDK callback boundary. Failures become visible ledger issues. */
  public enqueue(envelope: IngestionEnvelope): void {
    this.pending += 1;
    this.coverage.setIngestionPending(this.pending);
    this.onChange();

    this.tail = this.tail
      .then(async () => {
        await Promise.resolve();
        this.ledger.record(normalizeEnvelope(envelope, this.ownUserId));
      })
      .catch((error: unknown) => {
        const issue: IngestionIssue = {
          kind: 'issue',
          code: 'processing_failure',
          detail: error instanceof Error ? error.message : 'Unknown ingestion failure.',
          ...(envelope.event.eventId === undefined ? {} : { eventId: envelope.event.eventId }),
          ...(envelope.event.roomId === undefined ? {} : { roomId: envelope.event.roomId }),
          detectedAt: envelope.detectedAt,
        };
        this.ledger.recordFailure(issue);
      })
      .finally(() => {
        this.pending -= 1;
        this.coverage.setIngestionPending(this.pending);
        this.onChange();
      });
  }

  public async idle(): Promise<void> {
    await this.tail;
  }
}
