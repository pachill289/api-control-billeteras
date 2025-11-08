import fetch from "node-fetch";
import bs58 from "bs58";
import { PublicKey, Keypair, VersionedTransaction } from "@solana/web3.js";
import { connection} from "../config/connection.js";
import { readWallets, decodeSecretKeyToUint8, decodeSecretKey, generateUniquePercentages } from "../utils/fileManager.js";
import { getMint, getAccount, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";

export const buyTokenService = async ({
  publicKey,
  mint,
  amount,
  denominatedInSol,
  slippage,
  priorityFee,
  pool,
  secretKey
}) => {

  const payer = Keypair.fromSecretKey(decodeSecretKey(secretKey));

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

  if (!response.ok) throw new Error(await response.text());
  const txBuffer = await response.arrayBuffer();

  const transaction = VersionedTransaction.deserialize(new Uint8Array(txBuffer));
  transaction.sign([payer]);

  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latestBlockhash.blockhash;

  const feeInfo = await connection.getFeeForMessage(transaction.message);
  const txid = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(txid, "confirmed");

  return {
    txid,
    feeLamports: feeInfo?.value,
    feeSOL: feeInfo?.value / 1e9
  };
};

// comprar desde todas las billeteras
export const buyTokenAllWalletsService = async ({
  mint,
  amount,            // cantidad (en SOL o en unidades del token dependiendo de denominatedInSol)
  denominatedInSol,
  slippage,
  priorityFee,
  pool
}) => {

  const wallets = await readWallets();
  if (!wallets.length) throw new Error("No hay wallets almacenadas");

  const results = [];

  for (const w of wallets) {
    try {
      const payer = Keypair.fromSecretKey(Uint8Array.from(decodeSecretKey(w.secretKey)));
      const pub = new PublicKey(w.publicKey);

      // preparar POST a PumpPortal
      const resp = await fetch("https://pumpportal.fun/api/trade-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: pub.toBase58(),
          action: "buy",
          mint,
          amount,          // si denominatedInSol=true -> amount es en SOL. Si false -> amount es token.
          denominatedInSol,
          slippage,
          priorityFee,
          pool
        }),
      });

      if (!resp.ok) throw new Error(await resp.text());
      const txBuffer = await resp.arrayBuffer();

      // firmar transacción
      const tx = VersionedTransaction.deserialize(new Uint8Array(txBuffer));
      tx.sign([payer]);
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

      // enviar
      const txid = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(txid, "confirmed");

      results.push({ wallet: pub.toBase58(), success: true, txid });

    } catch (err) {
      results.push({ wallet: w.publicKey, success: false, error: err.message });
    }
  }

  return results;
};

// Servicio
export const fundWalletsRandomPercentService = async ({ funderPrivateKey }) => {
  if (!funderPrivateKey) throw new Error("Se requiere funderPrivateKey");

  const funder = loadWallet(funderPrivateKey); // Keypair
  const wallets = readWallets();
  const N = 20;

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

// Compra con diferentes porcentajes para cada wallet
export const buyTokenAllWalletsUniquePercentService = async ({
  mint,
  amount,            // total (en SOL si denominatedInSol=true, si false -> unidades token)
  denominatedInSol,
  slippage,
  priorityFee,
  pool
}) => {

  const wallets = await readWallets();
  if (!wallets.length) throw new Error("No hay wallets almacenadas");

  const N = wallets.length;
  // Generar porcentajes distintos que den el 100% que es el amount
  const percentages = generateUniquePercentages(N); // array longitud N

  // Convert percentages => porciones del amount
  // Mantendremos alta precisión en los montos y ajustamos el último para corregir residual
  const portions = [];
  for (let i = 0; i < N; i++) {
    // cada parte en unidades originales (SOL o token)
    const part = Math.round((amount * (percentages[i] / 100)) * 1e9) / 1e9; // 9 decimales (suficiente para SOL)
    portions.push(part);
  }
  // Corrección residual: ajustar último para que la suma de portions == amount
  const sumParts = Math.round(portions.reduce((s, v) => s + v, 0) * 1e9) / 1e9;
  const residualAmount = Math.round((amount - sumParts) * 1e9) / 1e9;
  portions[portions.length - 1] = Math.round((portions[portions.length - 1] + residualAmount) * 1e9) / 1e9;

  // Ejecutar las compras en serie (puedes paralelizar si quieres)
  const results = [];

  for (let i = 0; i < N; i++) {
    const w = wallets[i];
    const pct = percentages[i];
    const partAmount = portions[i];

    try {
      const payer = Keypair.fromSecretKey(Uint8Array.from(decodeSecretKey(w.secretKey)));
      const pub = new PublicKey(w.publicKey);

      // preparar POST a PumpPortal (igual que tu servicio original)
      const resp = await fetch("https://pumpportal.fun/api/trade-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: pub.toBase58(),
          action: "buy",
          mint,
          amount: partAmount,    // ahora enviamos la porción asignada
          denominatedInSol,      // mantenemos la misma unidad
          slippage,
          priorityFee,
          pool
        }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `HTTP ${resp.status}`);
      }

      const txBuffer = await resp.arrayBuffer();
      const tx = VersionedTransaction.deserialize(new Uint8Array(txBuffer));
      tx.sign([payer]);
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

      const txid = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(txid, "confirmed");

      results.push({
        wallet: pub.toBase58(),
        success: true,
        txid,
        percentage: pct,
        amount: partAmount
      });

    } catch (err) {
      results.push({
        wallet: w.publicKey,
        success: false,
        error: err.message,
        percentage: pct,
        amount: partAmount
      });
    }
  }

  return {
    success: true,
    totalAmount: amount,
    denominatedInSol,
    distribution: results
  };
};


export const sellTokenAllWalletsService = async ({
  mint,
  percentage,
  denominatedInSol,
  slippage,
  priorityFee,
  pool
}) => {

  const wallets = await readWallets();
  if (!wallets.length) throw new Error("No hay wallets almacenadas");

  const mintPub = new PublicKey(mint);
  const mintInfo = await getMint(connection, mintPub);
  const decimals = mintInfo.decimals ?? 0;

  const results = [];

  for (const w of wallets) {
    try {
      const payer = Keypair.fromSecretKey(Uint8Array.from(decodeSecretKey(w.secretKey)));
      const pub = new PublicKey(w.publicKey);

      const ataObj = await getOrCreateAssociatedTokenAccount(connection, payer, mintPub, pub);
      const tokenAccount = await getAccount(connection, ataObj.address);
      const balance = tokenAccount.amount;

      if (balance === 0n) {
        results.push({ from: pub.toBase58(), success: false, error: "Balance cero" });
        continue;
      }

      const amountToSell = (balance * BigInt(percentage)) / 100n;
      const amountHuman = Number(amountToSell) / Number(BigInt(10) ** BigInt(decimals));

      const resp = await fetch("https://pumpportal.fun/api/trade-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: pub.toBase58(),
          action: "sell",
          mint,
          amount: amountHuman,
          denominatedInSol,
          slippage,
          priorityFee,
          pool
        }),
      });

      if (!resp.ok) throw new Error(await resp.text());
      const txBuffer = await resp.arrayBuffer();

      const tx = VersionedTransaction.deserialize(new Uint8Array(txBuffer));
      tx.sign([payer]);
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

      const txid = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(txid, "confirmed");

      results.push({ from: pub.toBase58(), success: true, txid });

    } catch (err) {
      results.push({ from: w.publicKey, success: false, error: err.message });
    }
  }

  return results;
};
