import { describe, it, expect } from 'vitest';
import { NetworkError, isNetworkError } from './types';

describe('NetworkError', () => {
  it('has correct name and statusCode', () => {
    const err = new NetworkError(503, 'Service Unavailable');
    expect(err.name).toBe('NetworkError');
    expect(err.statusCode).toBe(503);
    expect(err.message).toBe('Service Unavailable');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isNetworkError', () => {
  it('matches a real NetworkError instance', () => {
    expect(isNetworkError(new NetworkError(500, 'fail'))).toBe(true);
  });

  it('matches an object with name "NetworkError" (cross-bundle fallback)', () => {
    const fake = new Error('fake');
    fake.name = 'NetworkError';
    expect(isNetworkError(fake)).toBe(true);
  });

  it('rejects a plain Error', () => {
    expect(isNetworkError(new Error('nope'))).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });

  it('rejects non-error objects', () => {
    expect(isNetworkError({ name: 'SomethingElse' })).toBe(false);
    expect(isNetworkError('NetworkError')).toBe(false);
  });
});
