import Dexie from 'dexie';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createElement, StrictMode } from 'react';

import { App } from '../../app/App';
import type { AppSnapshot } from '../../application/app-controller';
import type { QueueItem } from '../../domain/queue';
import {
  defaultAccountSettings,
  WorkflowRepository,
} from '../../infrastructure/persistence/workflow-repository';
import { WorkflowDatabase } from '../../infrastructure/persistence/workflow-database';

/**
 * Phase 5 scale measurement. This drives the real repository against real IndexedDB and renders
 * the real component tree, so the numbers describe the shipped code paths rather than a model of
 * them. It is reachable only from the benchmark build mode and never from production.
 */

export interface PhaseSample {
  readonly activities: number;
  readonly items: number;
  readonly projectionMs: number;
  readonly acceptMs: number;
  readonly perEventMs: number;
  readonly transitions: number;
}

export interface ScaleReport {
  readonly generatedAt: string;
  readonly target: { readonly activities: number; readonly items: number };
  readonly samples: readonly PhaseSample[];
  readonly startupMs: number;
  /** Cold mount of a queue that already holds the target item count. Happens once per page load. */
  readonly renderMs: number;
  /**
   * Median cost of the re-render the app performs after every ingested event and every command.
   * This is the half of per-event UI latency that `commandMs` does not cover: `commandMs` stops at
   * the projection query, before React runs.
   */
  readonly rerenderMs: number;
  readonly rerenderSamples: readonly number[];
  readonly commandMs: number;
  readonly commandSamples: readonly number[];
  readonly schedulerMs: number;
  readonly schedulerSamples: readonly number[];
  readonly migrationMs: number;
  readonly finalCounts: Record<string, number>;
  readonly databaseName: string;
}

const accountId = '@scale:benchmark.test|https://benchmark.test';

function now(): number {
  return performance.now();
}

async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = now();
  const value = await work();
  return [value, now() - started];
}

/** Deterministic ids keep repeated runs comparable and avoid crypto.randomUUID() cost skew. */
function sequentialIds(): () => string {
  let counter = 0;
  return () => `scale-${(counter += 1).toString(36).padStart(10, '0')}`;
}

function activityInput(index: number, conversation: number, detectedAt: number) {
  return {
    accountId,
    eventId: `$scale-event-${index}`,
    roomId: `!room-${conversation % 32}:benchmark.test`,
    sender: `@sender-${index % 8}:benchmark.test`,
    eventType: 'm.room.message',
    messageType: 'm.text',
    preview: `Synthetic scale activity ${index}`,
    detectedAt,
    localSequence: index,
    provenance: 'live',
    contentState: 'clear' as const,
    // Every tenth activity threads onto its conversation root, so items accumulate several
    // activities each rather than mapping one-to-one.
    relationKind: index % 10 === 0 ? ('independent' as const) : ('thread' as const),
    ...(index % 10 === 0 ? {} : { relationEventId: `$scale-event-${conversation}` }),
    roomName: `Scale room ${conversation % 32}`,
  };
}

async function countAll(database: WorkflowDatabase): Promise<Record<string, number>> {
  const entries = await Promise.all(
    [
      ['activities', database.activities],
      ['queueItems', database.queueItems],
      ['workflowTransitions', database.workflowTransitions],
      ['alertEffects', database.alertEffects],
      ['alertDeliveries', database.alertDeliveries],
      ['conversationKeys', database.conversationKeys],
    ].map(async ([name, table]) => [
      name as string,
      await (table as WorkflowDatabase['activities']).count(),
    ]),
  );
  return Object.fromEntries(entries) as Record<string, number>;
}

// The return type is declared rather than asserted. An `as unknown as AppSnapshot` cast used to
// stand here, and it silenced the compiler when the work-session lifecycle added a required
// `session` field: the benchmark kept rendering a snapshot the App could no longer read, and threw
// `Cannot read properties of undefined` on every scale run until one was finally executed. A
// declared return type contextually types the literal and fails the build on the next drift.
function syntheticSnapshot(items: readonly QueueItem[]): AppSnapshot {
  return {
    phase: 'active',
    accountLabel: '@scale:benchmark.test',
    homeserverLabel: 'https://benchmark.test',
    coverage: {
      connection: 'ready',
      monitoring: 'armed',
      networkBaselineConfirmed: true,
      ingestionPending: 0,
      openGapCount: 0,
      lastConfirmedAt: 0,
    },
    activities: [],
    ingestionIssues: [],
    ingestionDecisions: [],
    queueItems: items,
    storage: { available: true, persistenceSupported: true, persistent: true },
    alerts: { audio: 'ready', notifications: 'ready', webhook: 'disabled' },
    crypto: {
      state: 'ready',
      crossSigningReady: true,
      secretStorageReady: true,
      keyBackupReady: true,
      verification: 'idle',
    },
    session: { state: 'active', startedAt: 0, continuityWindowMs: 12 * 60 * 60 * 1000 },
  };
}

export interface ScaleProgress {
  readonly phase: string;
  readonly done: boolean;
  readonly samples: readonly PhaseSample[];
  readonly report?: ScaleReport;
  readonly error?: string;
}

export class ScaleBenchmark {
  private root: Root | undefined;
  private progressState: {
    phase: string;
    done: boolean;
    samples: PhaseSample[];
    report?: ScaleReport;
    error?: string;
  } = { phase: 'idle', done: false, samples: [] };

  /**
   * Starts a run without blocking the caller. Each checkpoint is published as soon as it lands, so
   * an overrunning run still yields its growth curve instead of nothing at all.
   */
  public start(ladder: readonly number[], targetItems: number): void {
    this.progressState = { phase: 'starting', done: false, samples: [] };
    void this.execute(ladder, targetItems)
      .then((report) => {
        this.progressState.report = report;
      })
      .catch((error: unknown) => {
        this.progressState.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.progressState.done = true;
        this.progressState.phase = 'done';
      });
  }

  public progress(): ScaleProgress {
    return {
      phase: this.progressState.phase,
      done: this.progressState.done,
      samples: [...this.progressState.samples],
      ...(this.progressState.report === undefined ? {} : { report: this.progressState.report }),
      ...(this.progressState.error === undefined ? {} : { error: this.progressState.error }),
    };
  }

  /**
   * Seeds through the real acceptActivity path up to each ladder point, sampling the projection
   * cost and the per-event cost of the controller's actual work at each one.
   */
  private async execute(ladder: readonly number[], targetItems: number): Promise<ScaleReport> {
    const targetActivities = ladder.at(-1) ?? 0;
    const databaseName = `ackwatch-scale-${Date.now()}`;
    const repository = new WorkflowRepository(databaseName, sequentialIds(), () => Date.now());
    const [, startupMs] = await timed(async () => {
      await repository.open();
      return await repository.projection(accountId);
    });
    await repository.putSettings(defaultAccountSettings(accountId, Date.now()));

    const samples = this.progressState.samples;
    const conversationStride = Math.max(1, Math.floor(targetActivities / targetItems));
    let seeded = 0;
    // Seed a window that ends at "now" rather than in the distant past. Deadlines materialize one
    // effect per elapsed repeat interval, so a stale seed clock would measure that accumulation
    // instead of the storage behaviour under test.
    let clock = Date.now() - (targetActivities + ladder.length + 16) * 1_000;

    for (const ladderPoint of ladder) {
      this.progressState.phase = `seeding to ${ladderPoint}`;
      const batchStarted = now();
      const batchSize = Math.max(0, ladderPoint - seeded);
      for (let index = seeded; index < ladderPoint; index += 1) {
        const conversation = Math.floor(index / conversationStride) * conversationStride;
        clock += 1_000;
        await repository.acceptActivity(activityInput(index, conversation, clock));
      }
      const acceptMs = now() - batchStarted;
      seeded = ladderPoint;

      this.progressState.phase = `measuring at ${ladderPoint}`;
      // The controller refreshes the whole projection after every accepted event, so the honest
      // per-event cost is one accept plus one projection at the current store size.
      const [projection, projectionMs] = await timed(() => repository.uiProjection(accountId));
      const singleStarted = now();
      clock += 1_000;
      await repository.acceptActivity(
        activityInput(seeded, Math.floor(seeded / conversationStride) * conversationStride, clock),
      );
      await repository.uiProjection(accountId);
      const perEventMs = now() - singleStarted;
      seeded += 1;

      samples.push({
        activities: seeded,
        items: projection.items.length,
        projectionMs,
        acceptMs: batchSize === 0 ? 0 : acceptMs / batchSize,
        perEventMs,
        transitions: projection.items.length,
      });
    }

    this.progressState.phase = 'final measurements';
    const finalProjection = await repository.projection(accountId);

    // A single user action at full size: the domain command plus the projection refresh that the
    // controller performs before the UI can update.
    // Repeated rather than sampled once: the first write transaction after bulk seeding can pay a
    // one-off cost that says nothing about the latency a user actually feels. The refresh is the
    // UI projection, which is what the controller performs after a command.
    const commandSamples: number[] = [];
    for (const target of finalProjection.items.slice(0, 6)) {
      const [, sample] = await timed(async () => {
        await repository.applyCommand(accountId, target.id, { kind: 'mark_viewed', at: clock });
        return await repository.uiProjection(accountId);
      });
      commandSamples.push(sample);
    }
    const sortedCommands = [...commandSamples].sort((left, right) => left - right);
    const commandMs = sortedCommands[Math.floor(sortedCommands.length / 2)] ?? 0;

    // The first pass materializes the backlog; the passes after it are what actually runs every
    // fifteen seconds, so both are reported rather than conflated.
    const schedulerSamples: number[] = [];
    for (let pass = 0; pass < 3; pass += 1) {
      const [, sample] = await timed(async () =>
        repository.prepareDueAlertDeliveries(accountId, clock, ['audio']),
      );
      schedulerSamples.push(sample);
    }
    const schedulerMs = schedulerSamples.at(-1) ?? 0;

    const { mountMs: renderMs, rerenderSamples } = this.measureRender(finalProjection.items);
    const sortedRerenders = [...rerenderSamples].sort((left, right) => left - right);
    const rerenderMs = sortedRerenders[Math.floor(sortedRerenders.length / 2)] ?? 0;
    const finalCounts = await countAll(repository.unsafeDatabaseForTests());
    repository.close();

    this.progressState.phase = 'migration';
    const migrationMs = await this.measureMigration(targetActivities);

    return {
      generatedAt: new Date().toISOString(),
      target: { activities: targetActivities, items: targetItems },
      samples: [...samples],
      startupMs,
      renderMs,
      rerenderMs,
      rerenderSamples,
      commandMs,
      commandSamples,
      schedulerMs,
      schedulerSamples,
      migrationMs,
      finalCounts,
      databaseName,
    };
  }

  /** Times each table's read and validation separately, so optimisation targets evidence. */
  public async profileProjection(databaseName: string): Promise<Record<string, number>> {
    const repository = new WorkflowRepository(databaseName, sequentialIds(), () => Date.now());
    await repository.open();
    const database = repository.unsafeDatabaseForTests();
    const timings: Record<string, number> = {};
    for (const [name, table] of [
      ['queueItems', database.queueItems],
      ['activities', database.activities],
      ['workflowTransitions', database.workflowTransitions],
      ['alertEffects', database.alertEffects],
      ['alertDeliveries', database.alertDeliveries],
    ] as const) {
      const readStarted = now();
      const rows = await (table as typeof database.activities)
        .where('accountId')
        .equals(accountId)
        .toArray();
      timings[`${name}.read`] = now() - readStarted;
      timings[`${name}.rows`] = rows.length;
    }
    const wholeStarted = now();
    await repository.projection(accountId);
    timings.projectionTotal = now() - wholeStarted;
    repository.close();
    return timings;
  }

  /**
   * Renders the real App component tree against a full-size projection. The render is flushed
   * synchronously: React 19 commits asynchronously by default, so timing `render()` alone measures
   * scheduling rather than the work, and reports a figure far too good to be true.
   */
  /**
   * Measures the two render costs separately, because they answer different questions.
   *
   * The mount is what a page load pays once. The re-render is what the app pays after *every*
   * ingested event and every command, and it is the half of per-event latency that `commandMs`
   * misses: that measurement stops at the projection query, before React runs.
   *
   * The re-render deliberately hands React all-new item objects with one item's content changed.
   * That is exactly what the app does today — `uiProjection` re-parses every row through zod, so
   * every object has fresh identity even when its values did not change. Measuring the cheaper
   * case of stable identities would describe an application that does not exist, and would make
   * `React.memo` look effective when nothing in the current code would let it hit.
   */
  private measureRender(items: readonly QueueItem[]): {
    mountMs: number;
    rerenderSamples: number[];
  } {
    const host = document.createElement('div');
    document.body.append(host);
    this.root = createRoot(host);
    const render = (snapshotItems: readonly QueueItem[]) => {
      flushSync(() => {
        this.root?.render(
          createElement(
            StrictMode,
            null,
            createElement(App, { snapshot: syntheticSnapshot(snapshotItems) }),
          ),
        );
      });
      // Force style and layout so the measurement includes what the browser must do to show it.
      void host.getBoundingClientRect().height;
    };

    const mountStarted = now();
    render(items);
    const mountMs = now() - mountStarted;

    // Repeated rather than sampled once, for the same reason the command measurement is: the first
    // pass after a mount pays one-off costs that say nothing about steady-state latency.
    const rerenderSamples: number[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      const target = items[pass % items.length];
      const next = items.map((item) =>
        item === target
          ? {
              ...item,
              unseenActivityCount: item.unseenActivityCount + 1,
              updatedAt: item.updatedAt + 1,
            }
          : { ...item },
      );
      const started = now();
      render(next);
      rerenderSamples.push(now() - started);
    }

    this.root.unmount();
    host.remove();
    return { mountMs, rerenderSamples };
  }

  /**
   * Measures a released-schema upgrade against a populated store: a v2 database carrying the
   * seeded row volume is reopened at the current version so the upgrade runs for real.
   */
  private async measureMigration(activityCount: number): Promise<number> {
    const databaseName = `ackwatch-scale-migration-${Date.now()}`;
    const legacy = new Dexie(databaseName);
    legacy.version(2).stores({
      coverageIssues: 'id, [accountId+status], accountId, roomId, updatedAt',
      queueItems: 'id, accountId, [accountId+status], [accountId+updatedAt], conversationKey',
      activities: 'id, &[accountId+eventId], itemId, [accountId+itemId], detectedAt',
      conversationKeys: 'id, &[accountId+key], itemId',
      workflowTransitions: 'id, accountId, itemId, [accountId+itemId], at',
      alertEffects: 'id, accountId, itemId, [accountId+status], dueAt',
      settings: 'accountId, updatedAt',
      monitoringSessions: 'id, accountId, [accountId+startedAt]',
      ingestionIssues: 'id, [accountId+status], eventId, roomId, detectedAt',
      quarantine: 'id, accountId, sourceStore, quarantinedAt',
    });
    await legacy.open();
    const rows = Array.from({ length: activityCount }, (_, index) => ({
      id: `scale-migration-${index}`,
      accountId,
      eventId: `$migration-event-${index}`,
      roomId: '!room:benchmark.test',
      sender: '@sender:benchmark.test',
      eventType: 'm.room.message',
      messageType: 'm.text',
      preview: `Synthetic migration activity ${index}`,
      detectedAt: index,
      localSequence: index,
      provenance: 'live',
      contentState: 'clear',
      itemId: `scale-migration-item-${index % 1000}`,
      relationKind: 'independent',
      edited: false,
      redacted: false,
    }));
    await legacy.table('activities').bulkAdd(rows);
    legacy.close();

    const upgraded = new WorkflowDatabase(databaseName);
    const [, migrationMs] = await timed(async () => {
      await upgraded.open();
      return await upgraded.activities.count();
    });
    upgraded.close();
    await WorkflowDatabase.delete(databaseName);
    return migrationMs;
  }
}

declare global {
  interface Window {
    __ackwatchScale?: ScaleBenchmark;
  }
}

export function installScaleBenchmark(): void {
  window.__ackwatchScale = new ScaleBenchmark();
  document.documentElement.dataset.scaleBenchmark = 'ready';
}
