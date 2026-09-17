import type { Identity, SignerSession } from '@arkade-os/sdk';

/**
 * Give the SDK an identity whose signing methods belong to one unlocked session.
 * An SDK operation may await network data before signing, so checking only when the
 * operation starts is insufficient: the wallet could lock or change sessions meanwhile.
 * The runtime supplies assertCurrent, which rejects calls from that obsolete session.
 *
 * These checks prevent new signing calls; they cannot cancel a call already underway
 * or revoke a signature already produced. Delegation also checks before submission.
 */
export function sessionIdentity(identity: Identity, assertCurrent: () => void): Identity {
  // The SDK reads this public descriptor to check derivation/operator networks.
  // Preserve that metadata without exposing additional, unguarded signing methods.
  const metadata = 'descriptor' in identity ? { descriptor: identity.descriptor } : {};
  return {
    ...metadata,
    // Public-key reads do not authorize spending and remain available after locking.
    xOnlyPublicKey: () => identity.xOnlyPublicKey(),
    compressedPublicKey: () => identity.compressedPublicKey(),
    sign: async (tx, indexes) => {
      assertCurrent();
      return identity.sign(tx, indexes);
    },
    signMessage: async (message, type) => {
      assertCurrent();
      return identity.signMessage(message, type);
    },
    signerSession: () => {
      assertCurrent();
      // The returned signer can outlive this call, so it needs its own guards too.
      return sessionSigner(identity.signerSession(), assertCurrent);
    },
  };
}

/**
 * Batch signing uses a multi-step MuSig2 session, with awaits between nonce exchange
 * and signing. Recheck at every step so an existing signer cannot continue after the
 * wallet locks. Only the public-key accessor is exempt, as on the identity above.
 */
function sessionSigner(signer: SignerSession, assertCurrent: () => void): SignerSession {
  return {
    getPublicKey: () => signer.getPublicKey(),
    init: async (...args) => {
      assertCurrent();
      return signer.init(...args);
    },
    getNonces: async () => {
      assertCurrent();
      return signer.getNonces();
    },
    aggregatedNonces: async (...args) => {
      assertCurrent();
      return signer.aggregatedNonces(...args);
    },
    sign: async () => {
      assertCurrent();
      return signer.sign();
    },
  };
}
