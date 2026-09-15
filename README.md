# Arkade Wallet Extension

A Tapscript-focused Bitcoin L2 wallet delivered as a Manifest V3 browser extension for the
[Arkade](https://arkadeos.com) protocol. It runs the `@arkade-os/sdk` `Wallet` directly inside the
extension's background service worker (the SDK's PWA-oriented `ServiceWorkerWallet` does not work in
an MV3 SW), persists wallet state to IndexedDB so it survives the ~30s SW idle-kill, and injects a
`window.arkadeWallet` provider into pages so dapps can connect, read balances, and request approvals.
The differentiator is first-class understanding of VTXO taproot script trees — collaborative,
timelocked unilateral-exit, and custom-condition leaves — which no other Bitcoin wallet exposes.

Built with [WXT](https://wxt.dev) + React.

For application integration, see [linked Arkade signing](docs/ARKADE-SIGNING.md), including
single-step escrow release signing and staged checkpoint approval.

Regtest defaults to Nigiri's operator on port `7070` and Esplora on `30000`.
For custom local ports, copy [.env.example](.env.example) to `.env.local` and set
the overrides there. Restart the development servers or rebuild the extension
after editing; both the extension and test webapp use these settings.
