// derive-from-mnemonic.js
import bip39 from "bip39";
import dotenv from "dotenv";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";
import { Buffer } from "buffer";

dotenv.config();
const mnemonic = process.env.SEED_FUND; // Frase semilla de la cuenta con fondos
const seed = await bip39.mnemonicToSeed(mnemonic); // Buffer
// derivation path standard para Solana: m/44'/501'/0'/0'
const derived = derivePath("m/44'/501'/0'/0'", seed.toString("hex"));
const keypair = Keypair.fromSeed(derived.key);
console.log("PUBLIC:", keypair.publicKey.toBase58());
console.log("SECRET_B64:", Buffer.from(keypair.secretKey).toString("base64"));
