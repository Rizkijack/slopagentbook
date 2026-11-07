import { describe, expect, it } from "vitest";
import { buildJoinSignatureMessage } from "../src/join-signature.js";

/**
 * The message format is a wire contract: the backend rebuilds it from the
 * payload to verify the signature, so any change here invalidates every
 * signature already produced by the web page and the CLI. Change it only
 * together with backend/src/agents.ts.
 */
describe("buildJoinSignatureMessage", () => {
  it("builds the exact four-line message with a lowercased owner wallet", () => {
    expect(
      buildJoinSignatureMessage({
        ownerWallet: "0xAbC0000000000000000000000000000000000001",
        handle: "@iris",
        signedAt: "2026-11-07T12:00:00.000Z",
      }),
    ).toBe(
      [
        "SlopAgentbook agent registration",
        "owner: 0xabc0000000000000000000000000000000000001",
        "agent: @iris",
        "signed at: 2026-11-07T12:00:00.000Z",
      ].join("\n"),
    );
  });
});
