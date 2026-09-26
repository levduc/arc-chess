import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  WireFormatError,
  decodeWire,
  parseMatchEvent,
  parseRelayMessage,
  parseSignedAcceptance,
  parseSignedOffer,
  toWire,
  relayJoinDigest,
  signRelayJoin,
  verifyRelayJoin,
} from "../src/index.js";
import { sampleParams, sampleSignedState } from "./helpers/fixtures.js";

describe("wire validators", () => {
  it("round-trips a state message through toWire/decodeWire/parseRelayMessage", () => {
    const msg = { type: "state" as const, channelId: sampleSignedState.state.channelId, signed: sampleSignedState };
    expect(parseRelayMessage(decodeWire(toWire(msg)))).toEqual(msg);
  });
  it("drops unknown keys and rebuilds objects", () => {
    const msg = {
      type: "state",
      channelId: sampleSignedState.state.channelId,
      signed: { ...sampleSignedState, extra: 1 },
      junk: true,
    };
    const parsed = parseRelayMessage(decodeWire(toWire(msg)));
    expect(Object.keys(parsed).sort()).toEqual(["channelId", "signed", "type"]);
    expect(Object.keys(parsed.type === "state" ? parsed.signed : {}).sort()).toEqual(["sigA", "sigB", "state"]);
  });
  it.each([
    ["not json", "{"],
    ["bad bigint", '{"$bigint":"12x"}'],
  ])("decodeWire rejects %s with WireFormatError", (_n, text) => {
    expect(() => decodeWire(text)).toThrow(WireFormatError);
  });
  it.each([
    ["wrong type tag", { type: "hello" }],
    ["state channelId mismatch", { type: "state", channelId: `0x${"11".repeat(32)}`, signed: sampleSignedState }],
    [
      "turnNum as number",
      {
        type: "state",
        channelId: sampleSignedState.state.channelId,
        signed: { ...sampleSignedState, state: { ...sampleSignedState.state, turnNum: 1 } },
      },
    ],
    [
      "sig not hex",
      { type: "state", channelId: sampleSignedState.state.channelId, signed: { ...sampleSignedState, sigA: "zz" } },
    ],
    [
      "close by 2",
      {
        type: "close",
        channelId: sampleSignedState.state.channelId,
        close: { stateHash: `0x${"00".repeat(32)}`, by: 2, sig: "0x" },
      },
    ],
  ])("parseRelayMessage rejects %s", (_n, x) => {
    expect(() => parseRelayMessage(x)).toThrow(WireFormatError);
  });
  it("parseMatchEvent requires two-element participant/signer tuples and bigint amounts", () => {
    const offerId = `0x${"ab".repeat(32)}`;
    expect(parseMatchEvent({ offerId, params: sampleParams })).toEqual({ offerId, params: sampleParams });
    expect(() =>
      parseMatchEvent({ offerId, params: { ...sampleParams, participants: [sampleParams.participants[0]] } }),
    ).toThrow(WireFormatError);
    expect(() => parseMatchEvent({ offerId, params: { ...sampleParams, deposit: "5" } })).toThrow(WireFormatError);
  });
  it("parseSignedOffer only accepts the chess template", () => {
    const offer = {
      template: "go",
      player: sampleParams.participants[0],
      signer: sampleParams.signers[0],
      deposit: 1n,
      stakePerGame: 1n,
      challengeTimeout: 600n,
      expiresAt: 1n,
      nonce: `0x${"01".repeat(32)}`,
    };
    expect(() => parseSignedOffer({ offer, sig: "0x" })).toThrow(WireFormatError);
    expect(parseSignedOffer({ offer: { ...offer, template: "chess" }, sig: "0x" }).offer.template).toBe("chess");
  });
  it("parseSignedAcceptance rejects a non-canonical offerId", () => {
    const acceptance = {
      offerId: "./0x" + "ab".repeat(32),
      player: sampleParams.participants[1],
      signer: sampleParams.signers[1],
      nonce: `0x${"02".repeat(32)}`,
    };
    expect(() => parseSignedAcceptance({ acceptance, sig: "0x" })).toThrow(WireFormatError);
  });
});

describe("relay join signature", () => {
  it("verifies only for the signing key, channel and nonce", async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const ch = `0x${"cd".repeat(32)}` as const;
    const nonce = `0x${"ef".repeat(32)}` as const;
    const sig = await signRelayJoin(acct, ch, nonce);
    expect(await verifyRelayJoin(ch, nonce, acct.address, sig)).toBe(true);
    expect(await verifyRelayJoin(ch, `0x${"00".repeat(32)}`, acct.address, sig)).toBe(false);
    expect(await verifyRelayJoin(`0x${"00".repeat(32)}`, nonce, acct.address, sig)).toBe(false);
    expect(await verifyRelayJoin(ch, nonce, acct.address, "0x1234")).toBe(false);
    expect(relayJoinDigest(ch, nonce)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
