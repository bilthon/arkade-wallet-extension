# Arkade Wallet Extension

A Tapscript-focused Bitcoin L2 wallet delivered as a Manifest V3 browser extension for the
[Arkade](https://arkadeos.com) protocol. It runs the `@arkade-os/sdk` `Wallet` directly inside the
extension's background service worker (the SDK's PWA-oriented `ServiceWorkerWallet` does not work in
an MV3 SW), persists wallet state to IndexedDB so it survives the ~30s SW idle-kill, and injects a
`window.arkadeWallet` provider into pages so dapps can connect, read balances, and request approvals.
The differentiator is first-class understanding of VTXO taproot script trees — collaborative,
timelocked unilateral-exit, and custom-condition leaves — which no other Bitcoin wallet exposes.

Built with [WXT](https://wxt.dev) + React.
