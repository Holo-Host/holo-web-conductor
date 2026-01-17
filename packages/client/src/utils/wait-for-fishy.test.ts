/**
 * Tests for Fishy extension detection utilities.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitForFishy, isFishyAvailable } from './wait-for-fishy';

describe('isFishyAvailable', () => {
  beforeEach(() => {
    // Reset window.holochain before each test
    delete (window as any).holochain;
  });

  afterEach(() => {
    delete (window as any).holochain;
  });

  it('returns false when window.holochain is undefined', () => {
    expect(isFishyAvailable()).toBe(false);
  });

  it('returns false when window.holochain exists but isFishy is false', () => {
    (window as any).holochain = { isFishy: false };
    expect(isFishyAvailable()).toBe(false);
  });

  it('returns true when window.holochain.isFishy is true', () => {
    (window as any).holochain = { isFishy: true };
    expect(isFishyAvailable()).toBe(true);
  });
});

describe('waitForFishy', () => {
  beforeEach(() => {
    delete (window as any).holochain;
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete (window as any).holochain;
    vi.useRealTimers();
  });

  it('resolves immediately if extension already available', async () => {
    (window as any).holochain = { isFishy: true };

    const promise = waitForFishy();
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves when fishy:ready event is fired', async () => {
    const promise = waitForFishy();

    // Simulate extension injecting itself
    (window as any).holochain = { isFishy: true };
    window.dispatchEvent(new Event('fishy:ready'));

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects after timeout if extension not detected', async () => {
    const promise = waitForFishy(1000);

    // Advance timers past timeout
    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow(
      'Fishy extension not detected. Please install the Fishy browser extension.'
    );
  });

  it('uses custom timeout', async () => {
    const promise = waitForFishy(500);

    // Not timed out yet
    vi.advanceTimersByTime(400);

    // Now timeout
    vi.advanceTimersByTime(200);

    await expect(promise).rejects.toThrow();
  });

  it('clears timeout when fishy:ready event fires', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const promise = waitForFishy(5000);

    // Fire the event before timeout
    vi.advanceTimersByTime(100);
    (window as any).holochain = { isFishy: true };
    window.dispatchEvent(new Event('fishy:ready'));

    await promise;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
