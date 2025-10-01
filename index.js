// index.js
import express from "express";
import bodyParser from "body-parser";
import fs from "fs/promises";
import {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  PublicKey,
} from "@solana/web3.js";
import dotenv from "dotenv";
import { Buffer } from "buffer";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const WALLET_STORE = "./wallets.json"; // archivo local para pruebas

const connection = new Connection(RPC, "confirmed");

// --- Util: guardar/leer wallets ---
async function readWallets() {
  try {
    const data = await fs.readFile(WALLET_STORE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}
async function saveWallets(list) {
  await fs.writeFile(WALLET_STORE, JSON.stringify(list, null, 2), "utf8");
}

// --- Endpoint: crear N wallets ---
app.post("/create-wallets", async (req, res) => {
  try {
    const { count } = req.body;
    const n = Number(count) || 1;
    if (n <= 0 || n > 1000)
      return res.status(400).json({ error: "count must be 1..1000" });

    const created = [];
    for (let i = 0; i < n; i++) {
      const kp = Keypair.generate();
      const publicKey = kp.publicKey.toBase58();
      const secretKey = Buffer.from(kp.secretKey).toString("base64");
      created.push({ publicKey, secretKey });
    }

    // Guardar (append) en WALLET_STORE
    const existing = await readWallets();
    const all = existing.concat(created);
    await saveWallets(all);

    return res
      .status(201)
      .json({ createdCount: created.length, wallets: created });
  } catch (err) {
    console.error("create-wallets error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// --- Endpoint: enviar SOL a una lista de direcciones ---
/*
 Body:
 {
   "destinations": ["Addr1","Addr2"],
   "amount": 0.01
 }
*/
app.post("/fund-wallets", async (req, res) => {
  try {
    const { destinations, amount } = req.body;
    if (!Array.isArray(destinations) || destinations.length === 0) {
      return res.status(400).json({
        error: "destinations debe ser un arreglo con al menos 1 dirección",
      });
    }
    if (typeof amount !== "number" || amount <= 0) {
      return res
        .status(400)
        .json({ error: "amount debe ser un número positivo (SOL)" });
    }

    const fundingB64 = process.env.FUNDING_SECRET_KEY_BASE64;
    if (!fundingB64)
      return res
        .status(500)
        .json({ error: "FUNDING_SECRET_KEY_BASE64 no configurado" });

    // Reconstruir Keypair del financiador
    const fundingSecret = Buffer.from(fundingB64, "base64");
    const fundingKeypair = Keypair.fromSecretKey(
      Uint8Array.from(fundingSecret)
    );

    // Verificar saldo
    const funderBalance = await connection.getBalance(fundingKeypair.publicKey);
    const required = Math.ceil(amount * destinations.length * LAMPORTS_PER_SOL);
    if (funderBalance < required) {
      return res.status(400).json({
        error: "Funder account tiene saldo insuficiente",
        funderBalance: funderBalance / LAMPORTS_PER_SOL,
        required: required / LAMPORTS_PER_SOL,
      });
    }

    const results = [];
    // Enviar transacciones secuencialmente para evitar conflictos de blockhash
    for (const dest of destinations) {
      try {
        const toPub = new PublicKey(dest);
        // Obtener latest blockhash
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("finalized");

        const tx = new Transaction({
          recentBlockhash: blockhash,
          feePayer: fundingKeypair.publicKey,
        }).add(
          SystemProgram.transfer({
            fromPubkey: fundingKeypair.publicKey,
            toPubkey: toPub,
            lamports: Math.round(amount * LAMPORTS_PER_SOL),
          })
        );

        tx.sign(fundingKeypair);
        const raw = tx.serialize();
        const sig = await connection.sendRawTransaction(raw);
        // Confirmar
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "finalized"
        );

        results.push({ to: dest, signature: sig, success: true });
      } catch (innerErr) {
        console.error("transfer error to", dest, innerErr);
        results.push({
          to: dest,
          error: innerErr.message || String(innerErr),
          success: false,
        });
      }
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error("fund-wallets error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.all("/balance", async (req, res) => {
  try {
    // aceptar tanto GET (query) como POST (body)
    const address = req.method === "GET" ? req.query.address : req.body.address;
    if (!address)
      return res.status(400).json({
        error: "address es requerido (query ?address= o body { address })",
      });

    // validar PublicKey
    let pub;
    try {
      pub = new PublicKey(address);
    } catch (e) {
      return res.status(400).json({ error: "address inválida" });
    }

    // obtener balance en lamports
    const lamports = await connection.getBalance(pub, "finalized"); // o 'confirmed' si prefieres
    const sol = lamports / LAMPORTS_PER_SOL;

    return res.status(200).json({
      address: pub.toBase58(),
      lamports, // 1 SOL = 1,000,000,000 lamports
      sol,
    });
  } catch (err) {
    console.error("balance error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// --- opcional: listar wallets guardadas (para debug) ---
app.get("/wallets", async (req, res) => {
  const list = await readWallets();
  res.json({ count: list.length, wallets: list });
});

app.listen(PORT, () => {
  console.log(`Solana API listening on port ${PORT}`);
  console.log(`RPC: ${RPC}`);
});
