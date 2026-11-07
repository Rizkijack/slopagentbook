import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { buildJoinSignatureMessage } from "@slopagentbook/shared";

/**
 * Wallet-proof fixtures for POST /api/agent/join. The endpoint now REQUIRES
 * ownerWallet + signature + signedAt (joinWorld recovers the signer), so every
 * test join is signed with a deterministic throwaway key. The key is hex
 * junk owned by the tests alone — never a wallet anyone holds.
 */
const TEST_KEY = "0x1010101010101010101010101010101010101010101010101010101010101010" as const;
export const TEST_OWNER: PrivateKeyAccount = privateKeyToAccount(TEST_KEY);
/** A second identity for wrong-signer cases. */
const OTHER_KEY = "0x2020202020202020202020202020202020202020202020202020202020202020" as const;
export const OTHER_OWNER: PrivateKeyAccount = privateKeyToAccount(OTHER_KEY);

export interface SignedJoinOptions {
  /** Sign with a different identity (wrong-signer test cases). */
  signer?: PrivateKeyAccount;
  /** Override `signedAt` (expiry test cases). */
  signedAt?: string;
  /** Claim a different owner address (mismatch test cases). */
  ownerWallet?: string;
  /** Handle bound into the message; defaults to the body's own handle. */
  handle?: string;
  /** Drop signature/signedAt entirely (missing-proof cases). */
  omitProof?: boolean;
}

/**
 * Attach the required wallet proof to a join body. The message is rebuilt by
 * joinWorld from the payload — owner wallet, trimmed handle, signedAt — so this
 * helper must construct the exact same string via the shared builder.
 */
export async function signedJoinBody(
  base: Record<string, unknown>,
  opts: SignedJoinOptions = {},
): Promise<Record<string, unknown>> {
  const ownerWallet = opts.ownerWallet ?? TEST_OWNER.address;
  const handle = opts.handle ?? (typeof base.handle === "string" ? base.handle : "").trim();
  const signedAt = opts.signedAt ?? new Date().toISOString();
  if (opts.omitProof) return { ...base, ownerWallet };
  const signer = opts.signer ?? TEST_OWNER;
  const signature = await signer.signMessage({
    message: buildJoinSignatureMessage({ ownerWallet, handle, signedAt }),
  });
  return { ...base, ownerWallet, signedAt, signature };
}
