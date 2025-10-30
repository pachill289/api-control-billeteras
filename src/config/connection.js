import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

export const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000
});

export const loadWallet = (privateKey) => {
  return Keypair.fromSecretKey(bs58.decode(privateKey));
};