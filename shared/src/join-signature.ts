/**
 * The registration signature message, built in ONE place. The owner wallet
 * signs exactly this string (personal_sign) to prove it controls the wallet
 * it claims: the web page signs it through the connected wallet, the CLI
 * signs it with `--owner-key`, and the backend rebuilds it from the join
 * payload and recovers the signer address. A corrected copy is still a copy —
 * never inline this format anywhere else.
 */
export interface JoinSignatureInput {
  ownerWallet: string;
  handle: string;
  signedAt: string;
}

export function buildJoinSignatureMessage({ ownerWallet, handle, signedAt }: JoinSignatureInput): string {
  return [
    "SlopAgentbook agent registration",
    `owner: ${ownerWallet.toLowerCase()}`,
    `agent: ${handle}`,
    `signed at: ${signedAt}`,
  ].join("\n");
}
