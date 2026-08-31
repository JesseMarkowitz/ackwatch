import Dexie, { type EntityTable } from 'dexie';
import { z } from 'zod';

export interface PersistedCoverageIssue {
  readonly id: string;
  readonly accountId: string;
  readonly kind: 'gap_recovery';
  readonly roomId: string;
  readonly boundaryEventId: string;
  readonly detail: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: 'open' | 'resolved';
}

const issueSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  kind: z.literal('gap_recovery'),
  roomId: z.string().startsWith('!'),
  boundaryEventId: z.string().min(1),
  detail: z.string().min(1),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  status: z.enum(['open', 'resolved']),
});

class CoverageDatabase extends Dexie {
  public coverageIssues!: EntityTable<PersistedCoverageIssue, 'id'>;

  public constructor(name: string) {
    super(name);
    this.version(1).stores({
      coverageIssues: 'id, [accountId+status], accountId, roomId, updatedAt',
    });
  }
}

export class CoverageIssueRepository {
  private readonly database: CoverageDatabase;

  public constructor(databaseName = 'ackwatch-workflow') {
    this.database = new CoverageDatabase(databaseName);
  }

  public async open(): Promise<void> {
    await this.database.open();
  }

  public async listOpen(accountId: string): Promise<readonly PersistedCoverageIssue[]> {
    const records = await this.database.coverageIssues
      .where('[accountId+status]')
      .equals([accountId, 'open'])
      .toArray();
    return records.map((record) => issueSchema.parse(record));
  }

  public async saveGapFailure(issue: Omit<PersistedCoverageIssue, 'id' | 'kind' | 'status'>) {
    const id = `${issue.accountId}|gap|${issue.roomId}|${issue.boundaryEventId}`;
    const record = issueSchema.parse({
      ...issue,
      id,
      kind: 'gap_recovery',
      status: 'open',
    });
    await this.database.coverageIssues.put(record);
    return record;
  }

  public async resolve(id: string, updatedAt: number): Promise<void> {
    await this.database.transaction('rw', this.database.coverageIssues, async () => {
      const existing = await this.database.coverageIssues.get(id);
      if (!existing) return;
      await this.database.coverageIssues.put(
        issueSchema.parse({ ...existing, status: 'resolved', updatedAt }),
      );
    });
  }

  public async clearAccount(accountId: string): Promise<void> {
    await this.database.coverageIssues.where('accountId').equals(accountId).delete();
  }

  public close(): void {
    this.database.close();
  }
}
