import { beforeEach, describe, expect, it, vi } from 'vitest';

const listeners: Array<(alarm: { name: string }) => void> = [];
const create = vi.fn(async () => {});
const clear = vi.fn(async () => true);

vi.stubGlobal('browser', {
  alarms: {
    create,
    clear,
    onAlarm: { addListener: vi.fn((listener) => listeners.push(listener)) },
  },
});

import { armAutoLock, clearAutoLock, registerAutoLock } from './auto-lock';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  listeners.length = 0;
  create.mockReset().mockResolvedValue(undefined);
  clear.mockReset().mockResolvedValue(true);
});

describe('auto-lock alarm adapter', () => {
  it('invokes the timeout only for the auto-lock alarm', () => {
    const onTimeout = vi.fn();
    registerAutoLock(onTimeout);

    listeners[0]({ name: 'arkade:renew' });
    listeners[0]({ name: 'someone-else' });
    expect(onTimeout).not.toHaveBeenCalled();

    listeners[0]({ name: 'arkade:auto-lock' });
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('arms the default or requested deadline and clears it', async () => {
    await armAutoLock();
    await armAutoLock(3);
    await clearAutoLock();

    expect(create).toHaveBeenNthCalledWith(1, 'arkade:auto-lock', { delayInMinutes: 10 });
    expect(create).toHaveBeenNthCalledWith(2, 'arkade:auto-lock', { delayInMinutes: 3 });
    expect(clear).toHaveBeenCalledWith('arkade:auto-lock');
  });

  it('does not let an old delayed clear erase a newer arm', async () => {
    const gate = deferred<boolean>();
    const order: string[] = [];
    clear.mockImplementationOnce(async () => {
      order.push('clear:start');
      const result = await gate.promise;
      order.push('clear:end');
      return result;
    });
    create.mockImplementationOnce(async () => void order.push('arm'));

    const clearing = clearAutoLock();
    const arming = armAutoLock();
    await vi.waitFor(() => expect(order).toEqual(['clear:start']));
    gate.resolve(true);
    await Promise.all([clearing, arming]);

    expect(order).toEqual(['clear:start', 'clear:end', 'arm']);
  });
});
