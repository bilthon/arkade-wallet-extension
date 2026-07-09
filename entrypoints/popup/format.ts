import type { NetworkName } from '@arkade-os/sdk';

/** Format a sats amount with thin-space grouping, e.g. 1234567 → "1,234,567". */
export function formatSats(sats: number): string {
  return sats.toLocaleString('en-US');
}

/** Truncate a long address/key for compact display: ark1qxy…7k4p. */
export function truncateMiddle(s: string, head = 10, tail = 6): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Human label for a network name (the read-only pill). */
export function networkLabel(network: NetworkName): string {
  switch (network) {
    case 'bitcoin':
      return 'Mainnet';
    case 'regtest':
      return 'Regtest (nigiri)';
    case 'mutinynet':
      return 'Mutinynet';
    case 'signet':
      return 'Signet';
    case 'testnet':
      return 'Testnet';
    default:
      return network;
  }
}

/** "just now" / "2m ago" relative time for snapshot staleness. */
export function relativeTime(epochMs: number): string {
  const secs = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

/** Compact "time until" string for an expiry countdown. e.g. "12 min", "1 h 5 min",
 *  "7 days 5 h", "soon". */
export function untilRelative(futureMs: number): string {
  const secs = Math.round((futureMs - Date.now()) / 1000);
  if (secs <= 0) return 'soon';
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  // Past two days, hours alone ("170 h") stop being readable — switch to a days tier.
  if (hrs >= 48) {
    const days = Math.floor(hrs / 24);
    const remHrs = hrs % 24;
    return remHrs > 0 ? `${days} days ${remHrs} h` : `${days} days`;
  }
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs} h ${remMins} min` : `${hrs} h`;
}
