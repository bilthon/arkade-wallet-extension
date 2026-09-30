# Delegation verification — 2026-09-29

The live core-integration test passed against the custom regtest stack using
SDK **0.4.39**, arkd **v0.9.4**, and Fulmine **v0.3.25**. The operator advertised
regtest and zero intent fees; Fulmine advertised a zero delegate fee.

The run used one disposable wallet and **100,000 regtest sats**, funded from the
lab miner. One ordinary block confirmed the deposit. No chain reset, clock change,
operator configuration change, or existing application wallet was used. The only
shared service restart was Fulmine, with its existing data preserved.

## Observed results

| UTC | Observation |
| --- | --- |
| 20:03:58 | Confirmed deposit observed before starting automation; no VTXO yet. |
| 20:04:04 | Application automation onboarded all 100,000 sats. |
| 20:04:04 | A probe-only submission failure produced the controlled retry message; immediate catch-up did not submit again. |
| 20:05:05 | Retry after the production cooldown was accepted by Fulmine and saved. |
| 20:05:06 | Recreated wallet retained acceptance without resubmitting. |
| 20:05:06 | Test-only SDK submission replaced the schedule with 20:06:36; all wallet sessions were disposed. |
| 20:05:48 | Fulmine restarted, retained its public key, and became ready again. |
| 20:06:40 | Indexer confirmed the original coin was spent while the wallet was offline. |
| 20:06:41 | Fresh SDK repositories discovered the equal-value replacement with later expiry. Maintenance saved its own acceptance and removed the spent coin's record. |

Original outpoint:
`38dd78fc85bb2b7760824e0a0bad4a449c71c57eacf53d68cf1f44d2cef1a62d:0`

Replacement outpoint:
`74f1ed228a8dd32c5762193f1d89f0f5d9413b0f3a67052548b087917e4012a9:0`

Both held 100,000 sats. Expiry moved from **2026-09-30 19:57:40 UTC** to
**2026-09-30 20:00:15 UTC**.

The live test passed in 213 seconds. The ordinary suite also passed: **596 tests
across 48 files**, plus TypeScript, Chrome build, and whitespace checks.
Reproduction instructions are in [README.md](README.md). Local evidence is in
`/tmp/delegation-live-results.json` and `/tmp/delegation-c6-live.log`.

## Actual browser restart and UI

A separate disposable wallet was tested in a fresh Chrome for Testing profile
with the production extension build loaded. The probe imported its wallet and
approved delegation through the popup UI. Its separate 100,000-sat deposit was
confirmed with one ordinary block and onboarded automatically.

At **20:10:52 UTC**, the extension had saved acceptance for
`d9b636f677efc487d0dc0568773496512a9fc607207d2b2507e9bb3ec275c254:0`.
The browser process was fully closed and reopened with the same test profile.
Before unlocking, the probe verified the locked screen, unchanged public
delegation records in `chrome.storage.local`, and identical SDK IndexedDB VTXO
keys. After unlocking through the UI, Coin Control showed **100,000 sats**,
**Delegated**, and the acceptance tooltip. The acceptance timestamp was unchanged;
the observed delegate POST count remained **one** through the immediate unlock/UI
check. This short browser observation does not cover a full maintenance interval;
the Node test separately awaited catch-up and checked deduplication.

This browser check used an existing local Playwright installation; no dependency
was added to the extension. Its driver is `/tmp/delegation-browser-probe.mjs` and
sanitized evidence is `/tmp/delegation-browser-results.json`. Secrets were never
printed; the fresh test profile stored only the extension's encrypted vault.
Both test browsers were closed and their disposable profiles removed afterward.

A second, unfunded browser wallet had delegation enabled and was left untouched
for **75 seconds**. The auto-lock alarm's scheduled deadline was identical before
and after that wait (20:11:34–20:12:49 UTC). This bounded check confirms the deadline
did not move during idle background operation; it does not claim a full ten-minute
auto-lock test. Evidence: `/tmp/delegation-browser-alarm-results.json`.

## Swept coin recovery

The outstanding Fulmine recovery question was verified on a separate, disposable
stack using the same SDK/operator/Fulmine versions and a **512-second** VTXO
lifetime. It had its own chain, volumes, containers, and localhost ports. The
shared stack's lifetime and clock were not changed.

The SDK-only probe onboarded 100,000 sats with automation disabled, disposed the
wallet, and waited for natural expiry at **20:20:54 UTC**. Ordinary blocks were
mined on the isolated chain so its median time followed wall-clock time. At
**20:21:01**, the indexer reported the coin as **swept and unspent**. Only then did
the probe reopen the wallet and delegate that recoverable input. Fulmine accepted
it, and the wallet was disposed again before execution.

At **20:22:04**, the indexer confirmed the old coin was spent. A fresh SDK wallet
discovered a new settled coin containing all **100,000 sats**:

- Original: `96faddab8a597f0b71db81a73949b7b40abd71954bad0c0720d8664c80afdf5e:0`
- Replacement: `ec4ba645b79ccb8769e750b6c3092ce72dd5dff364d4b04965f7a52df1a7c2de:0`

This proves Fulmine can execute recovery for a genuinely swept coin with these
versions. It is separate from testing the extension's online recovery fallback.
Evidence: `/tmp/delegation-expired-results.json`; probe:
`/tmp/delegc6-expired.mjs`. The short-expiry setup is a test configuration, not a
proposed wallet or shared-stack default.
The isolated containers, network, volumes, and generated secrets were removed
afterward. The shared development services remain running.

## Scope and limits

This validates real application policy, automation, maintenance, signing guards,
and tracking against live services. The reproducible Node test uses a browser
storage stub and in-memory SDK repositories. Actual browser persistence and UI
were verified separately as described above.

The accepted default schedule was deliberately replaced for this disposable coin
through a separate SDK session. This proves one offline renewal, including task
persistence through a real Fulmine restart; it does not prove the original
near-expiry schedule or indefinite renewal while locked. Genuine swept recovery
was tested separately above; the browser check did not exercise the expired-coin
UI or manual recovery. These checks verify the pinned local versions, not other
operators, paid delegates, or production networks.
