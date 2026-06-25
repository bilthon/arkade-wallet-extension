# G0 Spike — SW/SDK incompatibility gate

> The single most important de-risk of this project (PLAN.md §2, BUILD_PLAN GATE G0).
> Question: **does the Arkade SDK's `Wallet` — built for a PWA page service-worker —
> actually run inside an MV3 *extension* background service worker?** We need
> `Wallet.create` + `getBalance` + one real `settle()` to work in the background SW,
> backed by IndexedDB repositories, against local nigiri arkd.
>
> No feature work on the wallet runtime (Tracks C/E/F) should start until this is
> answered and recorded here.

## What the harness does

`src/spike.ts` → `runG0Spike(arkServerUrl?)` runs **inside the background service worker**:

1. `Wallet.create({ identity: MnemonicIdentity.fromMnemonic(<test mnemonic>), arkServerUrl, storage: { walletRepository: new IndexedDBWalletRepository(), contractRepository: new IndexedDBContractRepository() } })`
2. `wallet.getBalance()`
3. `wallet.settle()` (one attempt; logs each `SettlementEvent`)

It records a per-stage `ok | error | skipped` result and returns a structured
`G0SpikeResult`. It **never asserts success** — an unfunded regtest wallet will
legitimately make `settle()` throw "nothing to settle", which is still a real,
informative outcome (it proves the SDK runs and the operator/MuSig2 path is reachable
from the SW).

The test mnemonic is the well-known `abandon … about` BIP39 vector — throwaway only.

## One-command trigger

The spike is wired through the typed messaging chain as `runG0Spike`, so it is
triggerable two ways:

- **Popup button (easiest):** open the extension popup → set the ark server URL
  (defaults to `http://localhost:7070`) → click **Run G0 spike**. Per-stage results
  render in the popup; full JSON is logged in the background SW console.
- **Background SW console:** open the background service worker devtools
  (`chrome://extensions` → Arkade Wallet → *Inspect views: service worker*) and run:

  ```js
  // from any extension page console, or import in the SW:
  chrome.runtime.sendMessage({ type: 'runG0Spike', data: { arkServerUrl: 'http://localhost:7070' } })
  ```

  (The popup button is the supported path; the raw `sendMessage` envelope shape is
  managed by `@webext-core/messaging` so prefer the button.)

Watch the SW console for lines prefixed `[arkade:G0]` and the final
`[arkade:G0] result { … }` JSON.

## Full manual run (the G0 gate)

### 1. Start nigiri regtest with Ark

```bash
nigiri start --ark          # brings up arkd operator at http://localhost:7070 (+ chopsticks/esplora at :3000)
```

Requires Docker running. First run pulls the `ark` image, which can be large/slow.
Verify arkd is up:

```bash
curl -s http://localhost:7070/v1/info | head -c 400
```

(If you need funds to exercise a *real* settle: fund the wallet's boarding address —
`getBoardingAddress()` — with regtest coins via `nigiri faucet <addr>` / chopsticks,
then re-run the spike. Without funds, `settle()` is expected to report nothing to do.)

### 2. Build & load the extension unpacked

```bash
npm install
npm run build                # outputs .output/chrome-mv3
```

Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `.output/chrome-mv3`.

### 3. Trigger and read the result

Open the popup → **Run G0 spike** (or use the SW console). Read the `[arkade:G0]`
log lines.

### What to look for (records the gate answer)

- **`Wallet.create: ok`** — the SDK constructs in the MV3 background SW. ✅/❌
- **`getBalance: ok`** with a balance breakdown — operator reachable + IndexedDB
  read/write works in the SW. ✅/❌
- **`settle`** — `ok` (with funds → full MuSig2 multi-round `SignerSession` /
  `TreeNoncesEvent` / `TreeSignatureEvent` completes in the SW) **or** an error whose
  detail distinguishes "nothing to settle" (benign, unfunded) from a genuine SW/SDK
  failure (the thing this gate is checking for). ✅ / needs-offscreen ❌
- **SW survival:** does the SW stay alive through a multi-round `settle()`, or is it
  killed mid-flight (Chrome's ~30s idle kill)? If `settle()` cannot complete in the
  SW, the answer is **an offscreen document (`chrome.offscreen`, Chrome 116+) is
  required** for the long-lived settle/swap flows — which reshapes Track C/F.
- **🟣 Service availability:** confirm `nigiri start --ark` ships **no Fulmine
  delegate and no Boltz-Ark swap service** (expected: arkd + chopsticks only). This
  sets whether Track F (delegation, Phase 2) and Phase 6 (swaps) must run on
  **Mutinynet** (`https://mutinynet.arkade.sh`) or a self-hosted Fulmine/Boltz.
- **Mutinynet smoke:** re-run with `arkServerUrl = https://mutinynet.arkade.sh` to
  confirm the public-network path before relying on the nigiri inner loop.

### Optional: headless run

A headless run is possible with Playwright + a persistent Chromium context that loads
the unpacked extension (`--disable-extensions-except` / `--load-extension`), funds a
regtest boarding address, drives the popup button, and scrapes the `[arkade:G0]`
console output. Not committed for Phase 0 (it needs a funded-wallet fixture and the
nigiri ark stack healthy); the popup button + load-unpacked path above is the
supported gate.

## Run status

**Not yet run to completion in this environment.** The harness, trigger, and docs are
in place, but a real spike run was not captured here: `nigiri start --ark` stalled on
pulling the `ark` Docker image (`ark Pulling`, no progress, no arkd container after
several minutes) so arkd never came up on `:7070`. This is the **manual G0 gate** —
run the steps above on a machine where the nigiri ark stack starts, and record the
per-stage result (Wallet.create / getBalance / settle / SW-survival / delegate+Boltz
bundled?) back into this file.
