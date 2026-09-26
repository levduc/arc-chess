import { createWalletClient, http, type Address, type Chain, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/** Sends a transaction from some wallet (spec §3.1). Implementations: local key (v1), Circle CLI (Plan 6). */
export interface TxSender {
  readonly address: Address;
  send(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex>;
}

/**
 * Sends from a local private key. Used for participant wallets on Anvil and, with a channel's session key,
 * as the session-key sender for dispute transactions (spec §3.1 SessionKeyTxSender).
 */
export class LocalKeyTxSender implements TxSender {
  private readonly account: PrivateKeyAccount;
  private readonly wallet: WalletClient;

  constructor(privateKey: Hex, rpcUrl: string, private readonly chain: Chain) {
    this.account = privateKeyToAccount(privateKey);
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
  }

  get address(): Address {
    return this.account.address;
  }

  send(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex> {
    return this.wallet.sendTransaction({
      account: this.account,
      chain: this.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
  }
}

/**
 * Runs one send at a time per wallet, so two concurrent callers (funding two channels, a close racing a top-up) never
 * fetch the same pending nonce. A send is finished once the node has accepted the transaction (hash returned).
 */
export class SerialTxSender implements TxSender {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly inner: TxSender) {}
  get address(): Address {
    return this.inner.address;
  }
  send(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex> {
    const run = this.tail.then(() => this.inner.send(tx));
    this.tail = run.catch(() => undefined);
    return run;
  }
}
