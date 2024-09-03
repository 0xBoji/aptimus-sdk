import {
  AccountAuthenticator,
  Aptos,
  AptosConfig,
  Deserializer,
  EphemeralKeyPair,
  KeylessAccount,
  Network,
  SimpleTransaction,
  ZeroKnowledgeSig,
} from "@aptos-labs/ts-sdk";

import { AptimusClient, AptimusClientConfig } from "./AptimusClient";
import { fromB64, toB64 } from "./utils";
import { SyncStore, createSessionStorage } from "./store";
import { Encryption, createDefaultEncryption } from "./encryption";
import { WritableAtom, atom, onMount, onSet } from "nanostores";
import { decodeJwt } from "jose";
import { AptimusNetwork } from "./AptimusClient/type";

export interface AptimusFlowConfig extends AptimusClientConfig {
  /**
   * The storage interface to persist Aptimus data locally.
   * If not provided, it will use a sessionStorage-backed store.
   */
  store?: SyncStore;
  /**
   * The encryption interface that will be used to encrypt data before storing it locally.
   * If not provided, it will use a default encryption interface.
   */
  encryption?: Encryption;
}

export interface KeylessState {
  provider?: AuthProvider;
  address?: string;
  pepper?: string;
}

// State that session-bound, and is encrypted in storage.
export interface KeylessSession {
  ephemeralKeyPair?: string; // base64
  expiresAt?: number;

  jwt?: string;
  proof?: ZeroKnowledgeSig;

  keylessAccount?: string; // base64
}

export type AuthProvider = "google" | "facebook" | "twitch";

const createStorageKeys = (apiKey: string) => ({
  STATE: `@keyless/flow/state/${apiKey}`,
  SESSION: `@keyless/flow/session/${apiKey}`,
});

export class AptimusFlow {
  private storageKeys: { STATE: string; SESSION: string };
  private aptimusClient: AptimusClient;
  private encryption: Encryption;
  private encryptionKey: string;
  private store: SyncStore;

  $keylessSession: WritableAtom<{
    initialized: boolean;
    value: KeylessSession | null;
  }>;
  $keylessState: WritableAtom<KeylessState>;

  constructor(config: AptimusFlowConfig) {
    this.aptimusClient = new AptimusClient({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
    });
    this.encryptionKey = config.apiKey;
    this.encryption = config.encryption ?? createDefaultEncryption();
    this.store = config.store ?? createSessionStorage();
    this.storageKeys = createStorageKeys(config.apiKey);

    let storedState = null;
    try {
      const rawStoredValue = this.store.get(this.storageKeys.STATE);
      if (rawStoredValue) {
        storedState = JSON.parse(rawStoredValue);
      }
    } catch {
      // Ignore errors
    }

    this.$keylessState = atom(storedState || {});
    this.$keylessSession = atom({ initialized: false, value: null });

    // when this.$keylessSession is first accessed, call callback function
    onMount(this.$keylessSession, () => {
      this.getSession();
    });

    // when call this.$keylessState.set()
    // callback function will be called
    // save the newValue to storage
    onSet(this.$keylessState, ({ newValue }) => {
      this.store.set(this.storageKeys.STATE, JSON.stringify(newValue));
    });
  }

  getAptimusClient(): AptimusClient {
    return this.aptimusClient;
  }

  async createAuthorizationURL(input: {
    provider: AuthProvider;
    clientId: string;
    redirectUrl: string;
    network?: Network.MAINNET | Network.TESTNET | Network.DEVNET;
  }) {
    const ephemeralKeyPair = EphemeralKeyPair.generate();

    const params = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUrl,
      response_type: "id_token",
      scope: "openid profile email",
      nonce: ephemeralKeyPair.nonce,
    }).toString();

    let oauthUrl: string;
    switch (input.provider) {
      case "google": {
        oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
        break;
      }

      default:
        throw new Error(`Invalid provider: ${input.provider}`);
    }

    this.$keylessState.set({ provider: input.provider });
    await this.setSession({
      expiresAt: ephemeralKeyPair.expiryDateSecs * 1000, // milliseconds
      ephemeralKeyPair: toB64(ephemeralKeyPair.bcsToBytes()),
    });

    return oauthUrl;
  }

  // TODO: Should our SDK manage this automatically in addition to exposing a method?
  async handleAuthCallback(hash: string = window.location.hash) {
    const params = new URLSearchParams(
      hash.startsWith("#") ? hash.slice(1) : hash
    );

    // Before we handle the auth redirect and get the state, we need to restore it:
    const zkp = await this.getSession();

    if (!zkp || !zkp.ephemeralKeyPair) {
      throw new Error(
        "Start of sign-in flow could not be found. Ensure you have started the sign-in flow before calling this."
      );
    }

    const jwt = params.get("id_token");
    if (!jwt) {
      throw new Error("Missing ID Token");
    }

    const decodedJwt = decodeJwt(jwt);
    if (
      !decodedJwt.sub ||
      !decodedJwt.aud ||
      typeof decodedJwt.aud !== "string"
    ) {
      throw new Error("Missing JWT data");
    }

    const aptosConfig = new AptosConfig({ 
      network: Network.TESTNET,
      fullnode: 'https://faucet.testnet.suzuka.movementlabs.xyz/v1',
      faucet: 'https://faucet.testnet.suzuka.movementlabs.xyz/',
    });
    const aptos = new Aptos(aptosConfig);

    const ephemeralKeyPair = EphemeralKeyPair.fromBytes(
      fromB64(this.$keylessSession.get().value?.ephemeralKeyPair as string)
    );

    const keylessAccount = await aptos.deriveKeylessAccount({
      jwt,
      ephemeralKeyPair,
    });

    this.$keylessState.set({
      ...this.$keylessState.get(),
      pepper: toB64(keylessAccount.pepper), // base64
      address: keylessAccount.accountAddress.toString(),
    });

    await this.setSession({
      ...zkp,
      jwt,
      keylessAccount: toB64(keylessAccount.bcsToBytes())
    });

    return params.get("state");
  }

  private async setSession(newValue: KeylessSession | null) {
    if (newValue) {
      const storedValue = await this.encryption.encrypt(
        this.encryptionKey,
        JSON.stringify(newValue)
      );
      this.store.set(this.storageKeys.SESSION, storedValue);
    } else {
      this.store.delete(this.storageKeys.SESSION);
    }

    this.$keylessSession.set({ initialized: true, value: newValue });
  }

  async getSession() {
    if (this.$keylessSession.get().initialized) {
      return this.$keylessSession.get().value;
    }

    try {
      const storedValue = this.store.get(this.storageKeys.SESSION);
      if (!storedValue) return null;

      console.log("encryption key", this.encryptionKey);
      console.log("storedValue", storedValue);
      const state: KeylessSession = JSON.parse(
        await this.encryption.decrypt(this.encryptionKey, storedValue)
      );

      // TODO: Rather than having expiration act as a logout, we should keep the state that still is relevant,
      // and just clear out the expired session, but keep the other zkLogin state.
      if (state?.expiresAt && Date.now() > state.expiresAt) {
        console.log("Logout");
        await this.logout();
      } else {
        this.$keylessSession.set({ initialized: true, value: state });
      }
    } catch(error) {
      console.log("keyless session null");
      console.log(error);
      this.$keylessSession.set({ initialized: true, value: null });
    }

    return this.$keylessSession.get().value;
  }

  async logout() {
    this.$keylessState.set({});
    this.store.delete(this.storageKeys.STATE);

    await this.setSession(null);
  }

  // TODO: Should this return the proof if it already exists?
  async getProof({ network }: { network?: AptimusNetwork } = {}) {
    const zkp = await this.getSession();
    const { pepper } = this.$keylessState.get();

    if (zkp?.proof) {
      if (zkp.expiresAt && Date.now() > zkp.expiresAt) {
        throw new Error("Stored proof is expired.");
      }

      return zkp.proof;
    }

    if (!pepper || !zkp || !zkp.jwt || !zkp.ephemeralKeyPair) {
      throw new Error("Missing required parameters for proof generation");
    }

    const proof = await this.aptimusClient.createKeylessZkp({
      network,
      jwt: zkp.jwt,
      ephemeralKeyPairBase64: zkp.ephemeralKeyPair,
    });

    await this.setSession({
      ...zkp,
      proof,
    });

    return proof;
  }

  async sponsorTransaction({
    network,
    transaction,
  }: {
    network?: AptimusNetwork;
    transaction: SimpleTransaction;
  }) {
    const session = await this.getSession();

    if (!session || !session.jwt) {
      throw new Error("Missing required data for sponsorship.");
    }

    const transactionBytesBase64 = toB64(transaction.bcsToBytes());

    const { sponsorAuthBytesBase64, sponsorSignedTransactionBytesBase64 } =
      await this.aptimusClient.createSponsoredTransaction({
        jwt: session.jwt,
        network,
        transactionBytesBase64,
      });

    // deserialize fee payer authenticator
    const deserializer = new Deserializer(fromB64(sponsorAuthBytesBase64));
    const feePayerAuthenticator =
      AccountAuthenticator.deserialize(deserializer);

    // deserialize raw transaction
    const deserializerTransaction = new Deserializer(
      fromB64(sponsorSignedTransactionBytesBase64)
    );
    const sponsorSignedTransaction = SimpleTransaction.deserialize(
      deserializerTransaction
    );

    return {
      feePayerAuthenticator,
      sponsorSignedTransaction,
    };
  }

  async executeTransaction({
    feePayerAuthenticator,
    transaction,
    aptos,
  }: {
    network?: AptimusNetwork;
    feePayerAuthenticator?: AccountAuthenticator;
    transaction: SimpleTransaction;
    aptos: Aptos;
  }) {
    try {
      const zkp = await this.getSession();
      console.log("zkp", zkp);
      // if (!zkp || !zkp.jwt || !zkp.ephemeralKeyPair) {
      //   throw new Error("Missing required data for execution.");
      // }

      // const jwt = zkp.jwt;
      // const ephemeralKeyPair = EphemeralKeyPair.fromBytes(
      //   fromB64(zkp.ephemeralKeyPair)
      // );
      const keylessAccount = KeylessAccount.fromBytes(fromB64(zkp.keylessAccount));

      // NOTE: deriveKeylessAccount will call the prover API so it exceeds the rate limit
      // const keylessAccount = await aptos.deriveKeylessAccount({
      //   jwt,
      //   ephemeralKeyPair,
      // });

      const senderAuth = aptos.transaction.sign({
        signer: keylessAccount,
        transaction,
      });

      const response = await aptos.transaction.submit.simple({
        transaction,
        senderAuthenticator: senderAuth,
        feePayerAuthenticator,
      });

      // TODO: Should the parent just do this?
      const executedTransaction = await aptos.waitForTransaction({
        transactionHash: response.hash,
      });

      return executedTransaction;
    } catch (error) {
      throw error;
    }
  }

  async sponsorAndExecuteTransaction({
    network,
    transaction,
    aptos,
  }: {
    network?: AptimusNetwork;
    transaction: SimpleTransaction;
    aptos: Aptos;
  }) {
    const { feePayerAuthenticator, sponsorSignedTransaction } =
      await this.sponsorTransaction({
        network,
        transaction,
      });

    return await this.executeTransaction({
      network,
      feePayerAuthenticator,
      transaction: sponsorSignedTransaction,
      aptos,
    });
  }
}
