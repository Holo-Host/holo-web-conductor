/**
 * Tests for Holochain extension detection utilities.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitForHolochain, isWebConductorAvailable } from './wait-for-holochain';

describe('isWebConductorAvailable', () => {
  beforeEach(() => {
    // Reset window.holochain before each test
    delete (window as any).holochain;
  });

  afterEach(() => {
    delete (window as any).holochain;
  });

  it('returns false when window.holochain is undefined', () => {
    expect(isWebConductorAvailable()).toBe(false);
  });

  it('returns false when window.holochain exists but isWebConductor is false', () => {
    (window as any).holochain = { isWebConductor: false };
    expect(isWebConductorAvailable()).toBe(false);
  });

  it('returns true when window.holochain.isWebConductor is true', () => {
    (window as any).holochain = { isWebConductor: true };
    expect(isWebConductorAvailable()).toBe(true);
  });
});

describe('waitForHolochain', () => {
  beforeEach(() => {
    delete (window as any).holochain;
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete (window as any).holochain;
    vi.useRealTimers();
  });

  it('resolves immediately if extension already available', async () => {
    (window as any).holochain = { isWebConductor: true };

    const promise = waitForHolochain();
    await expect(promise).resolves.toBeUndefined();
  });

  it('resolves when holochain:ready event is fired', async () => {
    const promise = waitForHolochain();

    // Simulate extension injecting itself
    (window as any).holochain = { isWebConductor: true };
    window.dispatchEvent(new Event('holochain:ready'));

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects after timeout if extension not detected', async () => {
    const promise = waitForHolochain(1000);

    // Advance timers past timeout
    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow(
      'Holochain extension not detected. Please install the Holochain browser extension.'
    );
  });

  it('uses custom timeout', async () => {
    const promise = waitForHolochain(500);

    // Not timed out yet
    vi.advanceTimersByTime(400);

    // Now timeout
    vi.advanceTimersByTime(200);

    await expect(promise).rejects.toThrow();
  });

  it('clears timeout when holochain:ready event fires', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const promise = waitForHolochain(5000);

    // Fire the event before timeout
    vi.advanceTimersByTime(100);
    (window as any).holochain = { isWebConductor: true };
    window.dispatchEvent(new Event('holochain:ready'));

    await promise;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
