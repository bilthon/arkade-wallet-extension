import { describe, it, expect } from 'vitest';
import { withTimeout } from './async';

describe('withTimeout', () => {
  it('resolves with the value when the promise settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('propagates the underlying rejection unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('rejects with a labelled error when the promise does not settle in time', async () => {
    const neverSettles = new Promise<never>(() => {});
    await expect(withTimeout(neverSettles, 10, 'balance read')).rejects.toThrow(
      'balance read timed out after 10ms',
    );
  });

  it('defaults the label to "operation"', async () => {
    const neverSettles = new Promise<never>(() => {});
    await expect(withTimeout(neverSettles, 10)).rejects.toThrow('operation timed out after 10ms');
  });
});
