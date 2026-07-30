const ALARM_AUTO_LOCK = 'arkade:auto-lock';
const DEFAULT_AUTO_LOCK_MINUTES = 10;
let mutationTail: Promise<void> = Promise.resolve();

function serializeMutation(mutate: () => Promise<unknown>): Promise<void> {
  const result = mutationTail.then(mutate, mutate).then(() => undefined);
  mutationTail = result.catch(() => {});
  return result;
}

/** Register the browser alarm adapter once from the background entrypoint. */
export function registerAutoLock(onTimeout: () => void): void {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_AUTO_LOCK) onTimeout();
  });
}

/** Reset the idle deadline after trusted popup activity or a successful unlock. */
export async function armAutoLock(
  minutes: number = DEFAULT_AUTO_LOCK_MINUTES,
): Promise<void> {
  await serializeMutation(() =>
    browser.alarms.create(ALARM_AUTO_LOCK, { delayInMinutes: minutes }),
  );
}

/** Cancel the current idle deadline. */
export async function clearAutoLock(): Promise<void> {
  await serializeMutation(() => browser.alarms.clear(ALARM_AUTO_LOCK));
}
