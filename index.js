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
  sendAndConfirmTransaction,
  VersionedTransaction
} from "@solana/web3.js";
import dotenv from "dotenv";
import { Buffer } from "buffer";
import bs58 from "bs58";
import fetch from "node-fetch";
import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

dotenv.config();

const app = express();
app.use(express.json());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const WALLET_STORE = "./wallets.json"; // archivo local para pruebas

const connection = new Connection(RPC, "confirmed");

// --- Util: guardar/leer wallets ---
// Función para leer wallets desde el archivo
async function readWallets() {
  try {
    const data = await fs.readFile(WALLET_STORE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}
async function saveWallets(list) {
  await fs.writeFile(WALLET_STORE, JSON.stringify(list, null, 2), "utf8");
}

try {
  const res = await fetch("https://pumpportal.fun/api/trade-swap", { method: "POST" });
  console.log("✅ Conexión exitosa:", res.status);
} catch (err) {
  console.error("❌ Error de conexión:", err);
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

// ✅ Añade esta función
function isValidSolanaAddress(address) {
  try {
    const decoded = bs58.decode(address);
    return decoded.length === 32;
  } catch (err) {
    return false;
  }
}

app.post("/fund-wallets", async (req, res) => {
  try {
    const { publicKey, secretKey, mnemonic, amount } = req.body;
    const wallets = await readWallets();

    if (!Array.isArray(wallets) || wallets.length === 0) {
      return res.status(400).json({ error: "No hay wallets en wallets.json" });
    }

    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "amount debe ser un número positivo (SOL)" });
    }

    if (!((publicKey && secretKey) || mnemonic)) {
      return res.status(400).json({
        error: "Debes proporcionar 'publicKey' y 'secretKey' o la 'mnemonic' del financiador",
      });
    }

    // --- Crear Keypair del financiador
    let fundingKeypair;

    if (mnemonic) {
      const seed = await bip39.mnemonicToSeed(mnemonic);
      const derived = derivePath("m/44'/501'/0'/0'", seed.toString("hex")).key;
      fundingKeypair = Keypair.fromSeed(derived);
    } else {
      let secretBytes;
      try {
        if (/^[A-Za-z0-9+/=]+$/.test(secretKey) && secretKey.includes("=")) {
          secretBytes = Buffer.from(secretKey, "base64");
        } else {
          secretBytes = bs58.decode(secretKey);
        }
      } catch (err) {
        return res.status(400).json({ error: "Formato de secretKey inválido" });
      }

      const bytes = Uint8Array.from(secretBytes);

      if (bytes.length === 32) {
        fundingKeypair = Keypair.fromSeed(bytes);
      } else if (bytes.length === 64) {
        fundingKeypair = Keypair.fromSecretKey(bytes);
      } else {
        return res.status(400).json({
          error: `Tamaño de clave privada inválido (${bytes.length} bytes). Se esperaba 32 o 64.`,
        });
      }
    }

    // Validar coincidencia opcional
    if (publicKey && fundingKeypair.publicKey.toBase58() !== publicKey) {
      return res.status(400).json({
        error: "La publicKey no coincide con la clave privada proporcionada",
      });
    }

    // --- Verificar saldo del financiador
    const funderBalance = await connection.getBalance(fundingKeypair.publicKey);
    const required = Math.ceil(amount * wallets.length * LAMPORTS_PER_SOL);

    if (funderBalance < required) {
      return res.status(400).json({
        error: "Saldo insuficiente en la cuenta del financiador",
        balance: funderBalance / LAMPORTS_PER_SOL,
        required: required / LAMPORTS_PER_SOL,
      });
    }

    // --- Filtrar solo las public keys válidas del archivo
    const publicKeys = wallets
      .map((w) => (typeof w === "string" ? w : w.publicKey))
      .filter((key) => typeof key === "string" && isValidSolanaAddress(key));

    if (publicKeys.length === 0) {
      return res.status(400).json({ error: "No se encontraron claves públicas válidas en wallets.json" });
    }

    const results = [];

    // --- Enviar SOL a cada wallet
    for (const dest of publicKeys) {
      try {
        const toPub = new PublicKey(dest);
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
        const sig = await connection.sendRawTransaction(tx.serialize());
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "finalized"
        );

        results.push({ to: dest, signature: sig, success: true });
      } catch (innerErr) {
        console.error("Error enviando a", dest, innerErr);
        results.push({
          to: dest,
          error: innerErr.message || String(innerErr),
          success: false,
        });
      }
    }

    return res.status(200).json({
      from: fundingKeypair.publicKey.toBase58(),
      sentSOL: amount,
      count: results.length,
      results,
    });
  } catch (err) {
    console.error("fund-wallets error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});


//ENPOINT PARA MANDAR DE WALLETS.JSON A UNA BILLETERA

app.post("/collect-percent", async (req, res) => {
  try {
    const { to, percentage, feeBufferSol = 0.00001 } = req.body || {};

    if (!to || typeof to !== "string" || !isValidSolanaAddress(to)) {
      return res.status(400).json({ error: "Campo 'to' inválido o no proporcionado" });
    }

    const pct = Number(percentage);
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      return res.status(400).json({ error: "percentage debe ser un número > 0 y <= 100" });
    }

    const wallets = await readWallets();
    if (!Array.isArray(wallets) || wallets.length === 0) {
      return res.status(400).json({ error: "No hay wallets en wallets.json" });
    }

    const destPub = new PublicKey(to);
    const results = [];

    for (const w of wallets) {
      const walletObj = typeof w === "string" ? { publicKey: w } : w;
      const srcPubStr = walletObj.publicKey || walletObj.pub || null;
      const srcSecret = walletObj.secretKey || walletObj.secret || walletObj.privateKey || null;

      if (!srcSecret) {
        results.push({
          from: srcPubStr || null,
          success: false,
          error: "No se encontró secretKey para esta wallet; se omitió",
        });
        continue;
      }

      // Decodificar secretKey (array JSON, base64 o base58)
      let secretBytes;
      try {
        if (Array.isArray(srcSecret)) {
          secretBytes = Uint8Array.from(srcSecret);
        } else if (typeof srcSecret === "string") {
          const s = srcSecret.trim();
          if (/^\[.*\]$/.test(s)) {
            secretBytes = Uint8Array.from(JSON.parse(s));
          } else if (/^[A-Za-z0-9+/=]+$/.test(s) && s.includes("=")) {
            secretBytes = Buffer.from(s, "base64");
          } else {
            secretBytes = bs58.decode(s);
          }
        } else {
          throw new Error("Formato secretKey no reconocido");
        }
      } catch (err) {
        results.push({
          from: srcPubStr || null,
          success: false,
          error: "Error decodificando secretKey: " + String(err.message || err),
        });
        continue;
      }

      let bytes = Uint8Array.from(secretBytes);
      if (bytes.length > 64) bytes = bytes.slice(0, 64);

      let srcKeypair;
      try {
        if (bytes.length === 32) srcKeypair = Keypair.fromSeed(bytes);
        else if (bytes.length === 64) srcKeypair = Keypair.fromSecretKey(bytes);
        else {
          results.push({
            from: srcPubStr || null,
            success: false,
            error: `secretKey con longitud inválida (${bytes.length} bytes)`,
          });
          continue;
        }
      } catch (err) {
        results.push({
          from: srcPubStr || null,
          success: false,
          error: "Error creando Keypair: " + (err.message || String(err)),
        });
        continue;
      }

      if (srcPubStr && srcKeypair.publicKey.toBase58() !== srcPubStr) {
        results.push({
          from: srcKeypair.publicKey.toBase58(),
          success: false,
          error: "La publicKey del archivo no coincide con la secretKey proporcionada",
        });
        continue;
      }

      try {
        const balanceLamports = await connection.getBalance(srcKeypair.publicKey, "confirmed");
        const balanceSOL = balanceLamports / LAMPORTS_PER_SOL;

        if (!balanceLamports || balanceLamports <= 0) {
          results.push({
            from: srcKeypair.publicKey.toBase58(),
            success: false,
            error: "Saldo 0 o cuenta no creada",
            balanceSOL: 0,
          });
          continue;
        }

        const feeBufferLamports = Math.round(feeBufferSol * LAMPORTS_PER_SOL);

        // --- NUEVA LÓGICA: calcular sendLamports considerando percentage
        let sendLamports;
        if (pct === 100) {
          // enviar todo menos buffer para fees
          sendLamports = balanceLamports - feeBufferLamports;
        } else {
          // cantidad base por porcentaje
          sendLamports = Math.floor((balanceLamports * pct) / 100);
          // si al dejar esa cantidad el remanente es menor que el buffer, restamos para dejar buffer
          if (balanceLamports - sendLamports < feeBufferLamports) {
            sendLamports = balanceLamports - feeBufferLamports;
          }
        }

        // validar resultado
        if (sendLamports <= 0) {
          results.push({
            from: srcKeypair.publicKey.toBase58(),
            success: false,
            error: "Saldo insuficiente para enviar tras reservar buffer para fees",
            balanceSOL,
            intendedSendSOL: (Math.floor((balanceLamports * pct) / 100)) / LAMPORTS_PER_SOL,
            feeBufferSOL,
          });
          continue;
        }

        // Preparar y enviar transacción (firma por la wallet origen)
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
        const tx = new Transaction({
          recentBlockhash: blockhash,
          feePayer: srcKeypair.publicKey, // cada wallet paga su propia comisión aquí
        }).add(
          SystemProgram.transfer({
            fromPubkey: srcKeypair.publicKey,
            toPubkey: destPub,
            lamports: sendLamports,
          })
        );

        tx.sign(srcKeypair);
        const raw = tx.serialize();
        const sig = await connection.sendRawTransaction(raw);
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized");

        results.push({
          from: srcKeypair.publicKey.toBase58(),
          success: true,
          balanceSOL,
          sentSOL: sendLamports / LAMPORTS_PER_SOL,
          signature: sig,
        });
      } catch (err) {
        results.push({
          from: srcKeypair.publicKey.toBase58(),
          success: false,
          error: "Fallo al enviar: " + (err.message || String(err)),
        });
      }
    } // end for

    return res.status(200).json({ to: destPub.toBase58(), percentage: pct, feeBufferSol, results });
  } catch (err) {
    console.error("collect-percent error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});


app.post("/buy-token", async (req, res) => {
  try {
    const {
      publicKey,
      mint,
      amount,
      denominatedInSol,
      slippage,
      priorityFee,
      pool,
      secretKey
    } = req.body;

    // Validar parámetros obligatorios
    if (!publicKey || !mint || !amount || !denominatedInSol || !slippage || !priorityFee || !pool || !secretKey) {
      return res.status(400).json({ error: "Faltan parámetros requeridos." });
    }

    // Validar PublicKey
    let buyerPub;
    try { buyerPub = new PublicKey(publicKey); } 
    catch { return res.status(400).json({ error: "publicKey inválido" }); }

    // Reconstruir Keypair desde Base58
    let payer;
    try { payer = Keypair.fromSecretKey(bs58.decode(secretKey)); } 
    catch (err) { return res.status(400).json({ error: "Clave secreta inválida: " + err.message }); }

    // ===== Enviar solicitud a Pump.fun para comprar =====
    const response = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey,
        action: "buy",
        mint,
        amount,
        denominatedInSol,
        slippage,
        priorityFee,
        pool
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(500).json({ error: "Error al procesar swap: " + errorText });
    }

    // ===== Firmar la transacción =====
    const txBuffer = await response.arrayBuffer();
    const transaction = VersionedTransaction.deserialize(new Uint8Array(txBuffer));
    transaction.sign([payer]);

    // ===== Obtener fee estimada antes de enviar =====
    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = latestBlockhash.blockhash;

    const feeInfo = await connection.getFeeForMessage(transaction.message);
    console.log("===== Información de la transacción =====");
    console.log("Recent blockhash:", transaction.recentBlockhash);
    console.log("Signatures:", transaction.signatures.map(s => s.signature?.toString("base58")));
    console.log("Transaction message:", transaction.message);
    console.log("Fee estimada (lamports):", feeInfo?.value);
    console.log("Fee estimada (SOL):", feeInfo?.value / 1e9);

    // ===== Enviar transacción =====
    const txid = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(txid, "confirmed");

    return res.status(200).json({
      success: true,
      txid,
      message: "Compra completada correctamente",
      feeLamports: feeInfo?.value,
      feeSOL: feeInfo?.value / 1e9
    });

  } catch (err) {
    console.error("buy-token error:", err);
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


// --- Endpoint GET: obtener saldo e información de la cuenta ---
app.get("/account-info", async (req, res) => {
  try {
    const { address, commitment } = req.query || {};

    if (!address) {
      return res.status(400).json({ error: "Falta parámetro 'address' en la query" });
    }

    let pub;
    try {
      pub = new PublicKey(address);
    } catch {
      return res.status(400).json({ error: "Dirección inválida" });
    }

    // Obtener saldo
    const lamports = await connection.getBalance(pub, commitment || "confirmed");

    // Obtener información completa de la cuenta
    const accountInfo = await connection.getAccountInfo(pub, commitment || "confirmed");

    if (!accountInfo) {
      return res.status(404).json({ error: "Cuenta no encontrada" });
    }

    return res.status(200).json({
      address: pub.toBase58(),
      lamports,
      sol: lamports / LAMPORTS_PER_SOL,
      commitment: commitment || "confirmed",
      executable: accountInfo.executable,
      owner: accountInfo.owner.toBase58(),
      rentEpoch: accountInfo.rentEpoch,
      dataLength: accountInfo.data.length // tamaño de los datos en bytes
    });

  } catch (err) {
    console.error("account-info GET error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// --- Endpoint POST: obtener info de una o varias cuentas ---
/*app.post("/account-info", async (req, res) => {
  try {
    let { address, addresses, commitment } = req.body || {};

    // Normalizar a arreglo
    const list = [];
    if (address) list.push(address);
    if (Array.isArray(addresses)) list.push(...addresses);

    if (list.length === 0) {
      return res.status(400).json({ error: "Falta campo 'address' o 'addresses' en el body" });
    }

    const results = [];

    for (const addr of list) {
      try {
        const pub = new PublicKey(addr);
        const lamports = await connection.getBalance(pub, commitment || "confirmed");
        const accountInfo = await connection.getAccountInfo(pub, commitment || "confirmed");

        if (!accountInfo) {
          results.push({ address: addr, error: "Cuenta no encontrada" });
          continue;
        }

        results.push({
          address: pub.toBase58(),
          lamports,
          sol: lamports / LAMPORTS_PER_SOL,
          commitment: commitment || "confirmed",
          executable: accountInfo.executable,
          owner: accountInfo.owner.toBase58(),
          rentEpoch: accountInfo.rentEpoch,
          dataLength: accountInfo.data.length
        });
      } catch (err) {
        results.push({ address: addr, error: "Dirección inválida o error al procesar" });
      }
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error("account-info POST error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});
*/
app.post("/account-info-json", async (req, res) => {
  try {
    const { commitment } = req.body || {};
    const wallets = await readWallets();

    // Validar que existan wallets
    if (!Array.isArray(wallets) || wallets.length === 0) {
      return res.status(400).json({ error: "No se encontraron wallets en wallets.json" });
    }

    const results = [];

    // Recorrer cada wallet del archivo
    for (const w of wallets) {
      // Cada wallet en wallets.json debe tener { publicKey, secretKey }
      const addr = w.publicKey || w;
      try {
        const pub = new PublicKey(addr);
        const lamports = await connection.getBalance(pub, commitment || "confirmed");
        const accountInfo = await connection.getAccountInfo(pub, commitment || "confirmed");

        if (!accountInfo) {
          results.push({ address: addr, error: "Cuenta no encontrada" });
          continue;
        }

        results.push({
          address: pub.toBase58(),
          lamports,
          sol: lamports / LAMPORTS_PER_SOL,
          commitment: commitment || "confirmed",
          executable: accountInfo.executable,
          owner: accountInfo.owner.toBase58(),
          rentEpoch: accountInfo.rentEpoch,
          dataLength: accountInfo.data.length
        });
      } catch (err) {
        results.push({ address: addr, error: "Dirección inválida o error al procesar" });
      }
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error("account-info-json error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});
// 🔧 Endpoint /sell-token usando Pump.fun
app.post("/sell-token", async (req, res) => {
  try {
    const {
      publicKey,
      action,
      mint,
      amount,
      denominatedInSol,
      slippage,
      priorityFee,
      pool,
      secretKey
    } = req.body;

    // Validar parámetros obligatorios
    if (!publicKey || !action || !mint || !amount || !denominatedInSol || !slippage || !priorityFee || !pool || !secretKey) {
      return res.status(400).json({ error: "Faltan parámetros requeridos." });
    }

    // Validar PublicKey
    try { new PublicKey(publicKey); } catch { return res.status(400).json({ error: "publicKey inválido" }); }

    // Reconstruir Keypair desde Base58
    let payer;
    try {
      payer = Keypair.fromSecretKey(bs58.decode(secretKey));
    } catch (err) {
      return res.status(400).json({ error: "Clave secreta inválida: " + err.message });
    }

    // ===== Enviar solicitud a Pump.fun =====
    const response = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey,
        action,
        mint,
        amount,
        denominatedInSol,
        slippage,
        priorityFee,
        pool
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(500).json({ error: "Error al procesar swap: " + errorText });
    }

    // ===== Firmar y enviar la transacción =====
    const txBuffer = await response.arrayBuffer();
    const transaction = VersionedTransaction.deserialize(new Uint8Array(txBuffer));
    transaction.sign([payer]);

    const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
    const txid = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(txid, "confirmed");

    return res.status(200).json({
      success: true,
      txid,
      message: "Swap completado correctamente"
    });

  } catch (err) {
    console.error("sell-token error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/sell-token-all-wallets", async (req, res) => {
  try {
    const {
      mint,                 // string, mint del token
      percentage = 100,     // número 1..100 -> qué porción del balance vender
      denominatedInSol = false,
      slippage = 0.5,
      priorityFee = 0,
      pool = "auto"
    } = req.body;

    // validaciones básicas
    if (!mint) return res.status(400).json({ error: "Falta parámetro 'mint' en body" });
    if (typeof percentage !== "number" || percentage <= 0 || percentage > 100) {
      return res.status(400).json({ error: "percentage debe ser un número entre 1 y 100" });
    }

    const wallets = await readWallets();
    if (!Array.isArray(wallets) || wallets.length === 0) {
      return res.status(400).json({ error: "No hay wallets en wallets.json" });
    }

    const mintPub = new PublicKey(mint);
    // obtener info del mint (decimales)
    let mintInfo;
    try {
      mintInfo = await getMint(connection, mintPub);
    } catch (err) {
      return res.status(400).json({ error: "No se pudo obtener info del mint: " + (err.message || err) });
    }
    const decimals = mintInfo.decimals ?? 0;
    const results = [];

    // Procesar wallets secuencialmente (evita problemas de blockhash/ratelimit)
    for (const w of wallets) {
      const pub = w.publicKey;
      if (!pub) {
        results.push({ from: null, success: false, error: "Wallet sin publicKey" });
        continue;
      }

      // construir keypair
      let payer;
      try {
        const secretBytes = decodeSecretKeyToUint8(w.secretKey);
        payer = Keypair.fromSecretKey(Uint8Array.from(secretBytes));
      } catch (err) {
        results.push({ from: pub, success: false, error: "Error decodificando secretKey: " + (err.message || err) });
        continue;
      }

      try {
        const ownerPub = new PublicKey(pub);

        // Obtener o crear ATA (si no existe creará; requiere SOL en la wallet para fees si crea)
        let ata;
        try {
          const ataObj = await getOrCreateAssociatedTokenAccount(
            connection,
            payer,         // payer used to create ATA if needed
            mintPub,
            ownerPub
          );
          ata = ataObj.address;
        } catch (err) {
          results.push({ from: pub, success: false, error: "Error obteniendo/creando ATA: " + (err.message || err) });
          continue;
        }

        // Obtener token account info (balance en unidades mínimas, BigInt)
        let tokenAccount;
        try {
          tokenAccount = await getAccount(connection, ata);
        } catch (err) {
          // si no existe o no se pudo leer
          results.push({ from: pub, success: false, error: "No tiene token account para este mint o no se pudo leer" });
          continue;
        }

        const balanceBigInt = tokenAccount.amount; // BigInt
        if (balanceBigInt === 0n) {
          results.push({ from: pub, success: false, error: "Wallet sin tokens del mint indicado (0 balance)" });
          continue;
        }

        // calcular amount a vender en unidades mínimas (BigInt)
        const amountToSellBigInt = (balanceBigInt * BigInt(Math.floor(percentage))) / BigInt(100);
        if (amountToSellBigInt <= 0n) {
          results.push({ from: pub, success: false, error: "Cantidad a vender calculada es 0" });
          continue;
        }

        // convertir a monto decimal para pump.fun (tokens humanos)
        const divisor = BigInt(10) ** BigInt(decimals);
        // produce a float number (may lose precision for very large numbers but typical tokens are OK)
        const amountHuman = Number(amountToSellBigInt) / Number(divisor);

        // construir body para pump
        const sellBody = {
          publicKey: pub,
          action: "sell",
          mint,
          amount: amountHuman,        // envío en unidades "humanas" (ej: 1.5 tokens)
          denominatedInSol,
          slippage,
          priorityFee,
          pool
        };

        // llamar a pumpportal.fun
        const swapResp = await fetch("https://pumpportal.fun/api/trade-local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sellBody),
        });

        if (!swapResp.ok) {
          const txt = await swapResp.text();
          results.push({ from: pub, success: false, error: "Pump API error: " + txt });
          continue;
        }

        // recibir transacción, firmar y enviar
        const txBuffer = await swapResp.arrayBuffer();
        const transaction = VersionedTransaction.deserialize(new Uint8Array(txBuffer));
        transaction.sign([payer]);

        // garantizar blockhash actualizado
        try {
          const latest = await connection.getLatestBlockhash("finalized");
          transaction.recentBlockhash = latest.blockhash;
        } catch (e) {
          // no fatal
        }

        // enviar y confirmar
        const raw = transaction.serialize();
        const txid = await connection.sendRawTransaction(raw);
        await connection.confirmTransaction(txid, "confirmed");

        results.push({
          from: pub,
          success: true,
          txid,
          soldRaw: amountToSellBigInt.toString(),   // unidades mínimas
          soldHuman: amountHuman,
        });

      } catch (errWallet) {
        results.push({ from: pub, success: false, error: errWallet.message || String(errWallet) });
      }
    } // end for wallets

    return res.status(200).json({ mint, percentage, count: results.length, results });

  } catch (err) {
    console.error("sell-token-all-wallets error:", err);
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