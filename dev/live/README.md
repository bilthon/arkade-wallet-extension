# Live delegation verification

This opt-in test exercises the extension's delegation core against the custom
Arkade + Fulmine regtest stack. Normal `npm test` does not run it. It creates a
disposable wallet whose private key stays in memory and is discarded on exit.
Use only disposable regtest funds.

The test uses the pinned SDK and the real application policy checks, signing
guards, submission tracking, maintenance, and settlement automation. It substitutes
in-memory SDK repositories and a browser-storage stub for browser persistence.
No production timers or shared service settings are changed.

See [RESULTS.md](RESULTS.md) for the recorded live and browser verification.

## Run

Start the existing custom stack with the delegate enabled. Node also needs an
EventSource implementation: point to the `eventsource` package already installed
in the local infrastructure project.

```sh
LIVE_DELEGATION=1 \
LIVE_EVENTSOURCE_MODULE=/absolute/path/to/arkade-escrow-expiry-recovery/node_modules/eventsource/dist/index.js \
npx vitest run --config vitest.live.config.ts
```

Endpoint defaults are `http://localhost:7071` (Arkade),
`http://localhost:30010` (Esplora), and `http://localhost:7012` (Fulmine).
Override them with `LIVE_ARK_URL`, `LIVE_ESPLORA_URL`, and `LIVE_DELEGATE_URL`.
Only local HTTP endpoints are accepted.

When `awaiting-funding` prints a boarding address, send it exactly **100,000 sats**
from the lab's regtest miner and mine one ordinary block. The harness has no node
credentials and does not fund itself. Public progress/evidence is written to
`/tmp/delegation-live-results.json`; override with `LIVE_EVIDENCE_PATH` when
keeping multiple runs. No private keys or signed authorizations are recorded.

The test checks:

1. The confirmed deposit remains onchain before automation starts.
2. Application automation onboards the full value.
3. A simulated submission outage produces a controlled failure message. Catch-up
   respects the real retry cooldown and eventually records Fulmine's acceptance.
4. Recreating the wallet with serialized acceptance records does not resubmit the
   same coin.
5. A separate SDK session replaces the accepted task's schedule with a time
   90 seconds ahead. This explicit test-only step bypasses application deduplication;
   the application correctly refuses to resubmit an already accepted coin.
6. All wallet sessions and signing guards are stopped. The indexer then confirms
   the old coin was spent while the wallet was offline.
7. A fresh SDK cache discovers an equal-value replacement with a later expiry.
   Maintenance removes the spent coin's record and delegates the replacement.

At `offline-renewal-scheduled`, the wallet is disposed. A coordinator can restart
Fulmine before the printed execution time to additionally verify its task
persistence. That restart affects a shared service and is deliberately external
to this test; record whether it was actually performed with the run's evidence.

## Limits and remaining manual checks

This is a live core-integration test, not a browser end-to-end test. Wallet
recreation and a JSON storage round-trip do not prove an actual extension/service
worker restart, IndexedDB durability, popup behavior, or auto-lock timing. Check
those in the loaded extension separately.

Accelerated execution proves one offline renewal. It does not prove execution
at the original near-expiry schedule or indefinite renewals without unlocking.
Expired/recoverable execution also needs a genuinely expired/swept coin. Do not
fake its timestamp or change shared chain time: use a separately provisioned
short-expiry stack or a dedicated wallet left overnight, then record the result.

The test never resets the chain or stops shared services. A failure after funding
can leave disposable funds behind because its private key is not persisted.

## Separate browser restart check

Use a freshly created Chromium profile and load `.output/chrome-mv3` as an unpacked
extension. Build with the custom stack's endpoint overrides first. Do not reuse a
personal browser profile or existing wallet for this check.

1. Create or import a new disposable wallet. Keep its password in memory for the
   restart; do not capture the recovery phrase in logs, screenshots, or traces.
2. Open Settings → Delegation → Set up delegation. Review the terms and select
   **Approve and enable**. Check that the status becomes Enabled.
3. Open Receive → On-chain. Fund the displayed address with 100,000 regtest sats
   and mine one ordinary block. Wait for automatic onboarding and delegation.
4. Record only public acceptance fields from `chrome.storage.local` keys beginning
   `delegation:v1:`. Record the `vtxos` store's keys in the `arkade-wallet-regtest`
   IndexedDB database. Never dump all extension storage: it contains the vault.
5. Close the browser process completely, then reopen the same disposable profile.
   Before unlocking, check that the wallet is locked and the saved approval,
   acceptance timestamp/outpoint, and IndexedDB coin keys are unchanged.
6. Unlock and open Settings → Coin control. Check the full value, the Delegated
   badge, and its Accepted tooltip. Confirm that the acceptance timestamp stays
   unchanged and no new `/v1/delegate` POST was sent for that coin. Observe request
   URLs/methods only; do not record authorization bodies.

For an independent idle-timer check, enable delegation in an unfunded disposable
wallet. Read `chrome.alarms.get('arkade:auto-lock').scheduledTime`, leave the UI
untouched for at least 75 seconds, and read it again. The deadline should not move
while minute maintenance runs. Direct alarm reads do not send authenticated popup
messages, which would legitimately reset the timer. This verifies that maintenance
does not extend the deadline; it does not replace a full ten-minute lock test.

## Separate swept-coin recovery check

Use an isolated copy of the custom stack, with fresh volumes, unique container
names/ports, and `ARKD_VTXO_TREE_EXPIRY=512`. Do not change the shared stack or run
its reset script. Keep the same SDK/operator/Fulmine versions as the main test.

1. Create a disposable SDK wallet with a delegate provider and
   `settlementConfig: false`. Fund and confirm a 100,000-sat boarding deposit, then
   onboard it explicitly with `wallet.settle()`.
2. Dispose the wallet without delegating. Wait for the real expiry while mining
   ordinary blocks on this isolated chain so median time follows wall time. Do
   not fake coin metadata or set the node clock.
3. Query the exact outpoint until the SDK indexer response has
   `virtualStatus.state === 'swept'` and `isSpent === false`.
4. Reopen the SDK wallet, find that exact coin through the contract manager, and
   submit it with the delegate manager. The SDK schedules recoverable inputs
   shortly ahead by default. Assert acceptance, then dispose the wallet again.
5. Verify the old input becomes spent while offline. Reopen with fresh repositories
   and confirm a new settled coin with the full value. Stop and remove only this
   isolated test stack afterward.

This answers whether Fulmine can recover a swept coin. It does not exercise the
extension's separate online recovery fallback or expired-coin UI.
