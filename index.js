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
  VersionedTransaction
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

const SOL_MINT = "So11111111111111111111111111111111111111112";

app.post("/buy-token", async (req, res) => {
  try {
    const { userPublicKey, toMint, amount, slippage } = req.body;

    if (!userPublicKey || !toMint || !amount) {
      return res.status(400).json({
        error: "Faltan parámetros requeridos: userPublicKey, toMint, amount",
      });
    }

    // Validar public key
    try {
      new PublicKey(userPublicKey);
    } catch {
      return res.status(400).json({ error: "userPublicKey inválido" });
    }

    // Convertir a lamports (1 SOL = 1e9 lamports)
    const lamports = Math.floor(parseFloat(amount) * 1e9);
    const slippageBps = Math.floor((parseFloat(slippage || 0.5)) * 100);

    // === 1️⃣ OBTENER COTIZACIÓN ===
    const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${toMint}&amount=${lamports}&slippageBps=${slippageBps}`;
    const quoteResponse = await fetch(quoteUrl);

    if (!quoteResponse.ok) {
      const err = await quoteResponse.text();
      throw new Error(`Error al obtener quote (${quoteResponse.status}): ${err}`);
    }

    const quoteData = await quoteResponse.json();

    // === 2️⃣ CONSTRUIR TRANSACCIÓN ===
    const swapUrl = "https://lite-api.jup.ag/swap/v1/swap";
    const swapResponse = await fetch(swapUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userPublicKey: userPublicKey, // debe ser string
        quoteResponse: quoteData,     // el objeto quote recibido
        wrapAndUnwrapSol: true,
      }),
    });

    if (!swapResponse.ok) {
      const err = await swapResponse.text();
      throw new Error(`Error al construir swap (${swapResponse.status}): ${err}`);
    }

    const swapData = await swapResponse.json();

    // === 3️⃣ RESPUESTA FINAL ===
    return res.status(200).json({
      success: true,
      message: "Transacción de swap generada correctamente",
      quote: quoteData,
      swapTransaction: swapData.swapTransaction,
    });
  } catch (err) {
    console.error("buy-token endpoint error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/execute-swap", async (req, res) => {
  try {
    const { swapTransaction, rpc } = req.body;

    if (!swapTransaction) {
      return res.status(400).json({ error: "Falta parámetro swapTransaction" });
    }

    // --- Configurar conexión ---
    const connection = new Connection(
      rpc || "https://mainnet.helius-rpc.com/?api-key=3506b31d-e36e-4031-96b7-a683a4936146",
      "confirmed"
    );

    // --- Construir Keypair desde secret key base64 ---
    const secretKeyBase64 = "DLLguAhypOp8jvm2SFI0Zu0+ALUXhX8P4liEmOVfuT4S5mZ9wYc35MiqJPim62DLdTffDqJnjfG4zbZNbAGdHg==";
    const secretKeyBytes = Uint8Array.from(Buffer.from(secretKeyBase64, "base64"));
    const payer = Keypair.fromSecretKey(secretKeyBytes);

    // --- Decodificar transacción base64 ---
    const txBuffer = Buffer.from(swapTransaction, "base64");

    // --- Deserializar VersionedTransaction ---
    const transaction = VersionedTransaction.deserialize(txBuffer);

    // --- Firmar la transacción con el Keypair ---
    transaction.sign([payer]);

    // --- Enviar a la red ---
    const txid = await connection.sendRawTransaction(transaction.serialize());

    // --- Confirmar transacción ---
    await connection.confirmTransaction(txid, "confirmed");

    return res.status(200).json({
      success: true,
      message: "Swap ejecutado correctamente",
      txid,
    });
  } catch (err) {
    console.error("execute-swap error:", err);
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
