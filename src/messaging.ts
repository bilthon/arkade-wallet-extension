import { defineExtensionMessaging } from '@webext-core/messaging';

/**
 * Typed content <-> background protocol (PLAN.md §3, the `browser.runtime` hop).
 * `@webext-core/messaging` gives full TS inference — no stringly-typed switch.
 *
 * Phase 0 carries a single `ping` to prove the chain end-to-end; real provider
 * methods (connect/getBalance/signPsbt/…) land in later phases.
 */
export interface ProtocolMap {
  // data: optional caller-supplied echo payload; returns pong + SW-side timestamp.
  ping(data?: { echo?: string }): { pong: true; timestamp: number; echo?: string };

  // Phase-0 G0 spike trigger — runs Wallet.create + balance + settle() in the SW
  // and returns a structured log. Exposed over messaging so it is one-command
  // triggerable from the popup / extension console (see SPIKE.md).
  runG0Spike(data?: { arkServerUrl?: string }): import('./spike').G0SpikeResult;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
