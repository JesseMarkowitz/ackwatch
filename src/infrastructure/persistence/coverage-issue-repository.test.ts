import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { CoverageIssueRepository } from './coverage-issue-repository';

const databases: CoverageIssueRepository[] = [];

afterEach(() => {
  for (const database of databases) database.close();
  databases.length = 0;
});

describe('CoverageIssueRepository', () => {
  it('restores unresolved gap failures and keeps resolution explicit', async () => {
    const name = `ackwatch-test-${crypto.randomUUID()}`;
    const repository = new CoverageIssueRepository(name);
    databases.push(repository);
    await repository.open();
    const issue = await repository.saveGapFailure({
      accountId: '@monitor:example.test|https://example.test',
      roomId: '!room:example.test',
      boundaryEventId: '$boundary',
      detail: 'Could not join boundary.',
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    expect(await repository.listOpen(issue.accountId)).toHaveLength(1);
    await repository.resolve(issue.id, 2_000);
    expect(await repository.listOpen(issue.accountId)).toEqual([]);
  });
});
