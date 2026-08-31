import { describe, expect, it } from 'vitest';

import type { Clock } from './clock';

class FakeClock implements Clock {
  public constructor(private currentTime: number) {}

  public now(): number {
    return this.currentTime;
  }

  public advanceBy(duration: number): void {
    this.currentTime += duration;
  }
}

describe('Clock boundary', () => {
  it('lets domain tests advance time without consulting the wall clock', () => {
    const clock = new FakeClock(1_000);

    clock.advanceBy(5 * 60 * 1_000);

    expect(clock.now()).toBe(301_000);
  });
});
