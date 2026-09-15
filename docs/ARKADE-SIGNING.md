# Linked Arkade signing

`window.arkadeWallet.approveArkadeTransaction` approves a cooperative BTC payment
and its complete set of checkpoints together. The wallet validates the checkpoint
construction and links, then displays the final destinations, values, and fee in
one approval. `signPsbt` remains available for individual PSBTs.

Import the public types from `src/provider-api.ts`. Connect the site and unlock
the wallet before signing. Supply base64 or hex PSBTs with complete SDK input
metadata, including `witnessUtxo`, `tapLeafScript`, and the Arkade taproot tree.
All returned PSBTs are base64 and unfinalized; existing signatures are preserved.

Each checkpoint has one input. Use `inputIndexes: [0]` to request the wallet's
signature, or `[]` to include another participant's checkpoint for validation
only. Include every checkpoint, and select at least one input. The wallet derives
which payment inputs to sign from the selected checkpoints. This API currently
supports plain cooperative multisig BTC paths, including escrow releases; timed
or conditional selected paths and asset/data outputs are unsupported.

## Single-step approval

Use `signCheckpoints: true` to receive the payment and checkpoint signatures
immediately. This authorizes the application to hold both sets of signatures
and control submission; the wallet cannot enforce coordinated submission.

```ts
const result = await window.arkadeWallet.approveArkadeTransaction({
  arkadePsbt: releasePsbt,
  checkpoints: checkpointPsbts.map((psbt) => ({ psbt, inputIndexes: [0] })),
  signCheckpoints: true,
});

if (result.status === 'signed') {
  // Collect any remaining participant signatures, submit to the operator,
  // and finalize using your application's SDK transaction flow.
  useSignedTransactions(result.arkadePsbt, result.checkpoints);
}
```

## Staged approval

Omit `signCheckpoints` (defaults to `false`) to sign the payment first. After
operator submission, return the complete operator-signed checkpoint set using
the approval ID. A matching completion does not open another approval window.

```ts
const approval = await window.arkadeWallet.approveArkadeTransaction({
  arkadePsbt: releasePsbt,
  checkpoints: checkpointPsbts.map((psbt) => ({ psbt, inputIndexes: [0] })),
});

if (approval.status === 'awaiting-checkpoints') {
  // Application-specific: collect remaining payment signatures and submit.
  const operatorSignedCheckpoints = await submitPayment(approval.arkadePsbt);
  const result = await window.arkadeWallet.signArkadeCheckpoints({
    approvalId: approval.approvalId,
    checkpoints: operatorSignedCheckpoints,
  });
  await finalizeWithOperator(result.checkpoints);
}
```

The application-specific helpers above illustrate the lifecycle; they are not
wallet provider methods. The application handles operator communication,
remaining participant signatures, and finalization in both modes. Returned
checkpoints always follow the original approval-request order; completion inputs
are matched by transaction ID rather than array position.

Staged approvals expire 10 minutes after approval (`expiresAt` is Unix
milliseconds). They are held in background memory and cease to work after wallet
lock, account/network changes, disconnect/revocation, or background restart.
Reconnect does not restore an approval. Complete it from the same connected
origin and wallet session. Identical successful completion retries return the
saved result until expiry; concurrent completion returns `BUSY`. Malformed,
changed, missing, or expired approvals return `BAD_REQUEST`. A corrected request
can retry after validation failure.
