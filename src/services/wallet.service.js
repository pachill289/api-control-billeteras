import bs58 from "bs58";
import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { connection, loadWallet} from "../config/connection.js";
import { readWallets, saveWallets, generateBoundedIntPartition, generatePercentages } from "../utils/fileManager.js";

// crear wallets
export const createWallet = async (count) => {
  try {
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
    return all;

  } catch (err) {
    console.error("create-wallets error:", err);
    return err.message || String(err);
  }
};

// info wallets
export const getWalletsAccountInfo = async (commitment = "confirmed") => {
  const wallets = readWallets();

  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new Error("No se encontraron wallets en wallets.json");
  }

  const results = [];

  for (const w of wallets) {
    const addr = w.publicKey || w;

    try {
      const pub = new PublicKey(addr);
      const lamports = await connection.getBalance(pub, commitment);
      const accountInfo = await connection.getAccountInfo(pub, commitment);

      if (!accountInfo) {
        results.push({ address: addr, error: "Cuenta no encontrada" });
        continue;
      }

      results.push({
        address: pub.toBase58(),
        lamports,
        sol: lamports / LAMPORTS_PER_SOL,
        commitment,
        executable: accountInfo.executable,
        owner: accountInfo.owner.toBase58(),
        rentEpoch: accountInfo.rentEpoch,
        dataLength: accountInfo.data.length
      });
    } catch {
      results.push({ address: addr, error: "Dirección inválida" });
    }
  }

  return results;
};

// fondear billeteras (optimizado)
export const fundWallets = async (funderPrivateKey, amountSol) => {
  const funder = loadWallet(funderPrivateKey); // Keypair
  const wallets = readWallets();

  const lamports = Math.floor(amountSol * 1e9);

  for (const w of wallets) {
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: new PublicKey(w.publicKey), // <<--- FIX
          lamports,
        })
      );

      const sig = await sendAndConfirmTransaction(connection, tx, [funder], {
        skipPreflight: true, // + rápido
      });

      console.log(`✅ Financiada: ${w.publicKey} | ${amountSol} SOL | Tx: ${sig}`);

    } catch (err) {
      console.log(`❌ Error financiando ${w.publicKey}:`, err.message);
    }
  }
};

// Fondear billeteras con porcentajes distintos
export const fundWalletsRandomPercentService = async ({ funderPrivateKey }) => {
  if (!funderPrivateKey) throw new Error("Se requiere funderPrivateKey");

  const funder = loadWallet(funderPrivateKey); // Keypair
  const wallets = readWallets();
  const N = 5;

  if (wallets.length < N) throw new Error(`Se requieren al menos ${N} wallets registradas`);

  // Obtener balance del fundeador
  const balanceLamports = await connection.getBalance(funder.publicKey, "confirmed");
  const feeReserveLamports = Math.floor(0.02 * 1e9);
  if (balanceLamports <= feeReserveLamports) throw new Error("Balance insuficiente para fondear");

  const totalLamports = balanceLamports - feeReserveLamports;

  // Porcentajes 1–10 que suman 100
  const percentages = generateBoundedIntPartition(N, 100, 1, 10);

  // Convertimos porcentajes a lamports y corregimos residual
  const portionsLamports = percentages.map(pct => Math.floor((totalLamports * pct) / 100));
  const residual = totalLamports - portionsLamports.reduce((s, x) => s + x, 0);
  portionsLamports[portionsLamports.length - 1] += residual;

  const results = [];

  for (let i = 0; i < N; i++) {
    const toPub = new PublicKey(wallets[i].publicKey);
    const lamports = portionsLamports[i];

    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: toPub,
          lamports
        })
      );

      const sig = await sendAndConfirmTransaction(connection, tx, [funder], { skipPreflight: true });

      results.push({
        wallet: wallets[i].publicKey,
        success: true,
        percentage: percentages[i],
        sol: lamports / 1e9,
        tx: sig
      });

    } catch (err) {
      results.push({
        wallet: wallets[i].publicKey,
        success: false,
        percentage: percentages[i],
        error: err.message
      });
    }
  }

  return {
    success: true,
    totalSol: totalLamports / 1e9,
    distribution: results
  };
};

export const fundWalletsRandomService = async (funderPrivateKey, totalSol) => {
  const funder = loadWallet(funderPrivateKey);
  const wallets = readWallets();

  if (wallets.length < 20) throw new Error("Se requieren 20 billeteras.");

  const percentages = generatePercentages(20);
  const results = [];

  for (let i = 0; i < 20; i++) {
    const pct = percentages[i];
    const sol = (pct / 100) * totalSol;
    const lamports = Math.floor(sol * 1e9);

    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: new PublicKey(wallets[i].publicKey),
          lamports
        })
      );

      const sig = await sendAndConfirmTransaction(connection, tx, [funder], {
        skipPreflight: true,
      });

      results.push({
        wallet: wallets[i].publicKey,
        percentage: pct,
        sol,
        success: true,
        tx: sig
      });

    } catch (err) {
      results.push({
        wallet: wallets[i].publicKey,
        percentage: pct,
        sol,
        success: false,
        error: err.message
      });
    }
  }

  return {
    success: true,
    totalSol,
    results
  };
};


// enviar todo el SOL de wallets.json a una dirección
export const withdrawAllSOL = async (destinationAddress) => {
  const destination = new PublicKey(destinationAddress);
  const wallets = readWallets();
  const results = [];

  for (const wallet of wallets) {
    try {
      // Decodificar secretKey (string base58 o base64)
      let keyBytes;
      try {
        if (/^[A-Za-z0-9+/=]+$/.test(wallet.secretKey) && wallet.secretKey.includes("=")) {
          keyBytes = Buffer.from(wallet.secretKey, "base64");
        } else {
          keyBytes = bs58.decode(wallet.secretKey);
        }
      } catch {
        throw new Error("Clave privada inválida: " + wallet.publicKey);
      }

      const keypair =
        keyBytes.length === 64
          ? Keypair.fromSecretKey(Uint8Array.from(keyBytes))
          : Keypair.fromSeed(Uint8Array.from(keyBytes));

      const balance = await connection.getBalance(keypair.publicKey);
      if (balance === 0) {
        results.push({ wallet: wallet.publicKey, balance: 0, skipped: true });
        continue;
      }

      // Restar fee aproximado (~5000 lamports)
      const fee = 5000;
      const amountToSend = balance - fee;
      if (amountToSend <= 0) {
        results.push({ wallet: wallet.publicKey, error: "Saldo insuficiente para cubrir fee" });
        continue;
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");

      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: keypair.publicKey,
      }).add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: destination,
          lamports: amountToSend,
        })
      );

      tx.sign(keypair);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
      });

      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

      results.push({
        from: wallet.publicKey,
        to: destinationAddress,
        sentSOL: amountToSend / LAMPORTS_PER_SOL,
        signature: sig,
        success: true,
      });

    } catch (err) {
      results.push({
        wallet: wallet.publicKey,
        error: err.message,
        success: false,
      });
    }
  }

  return results;
};


