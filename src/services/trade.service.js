import fetch from "node-fetch";
import bs58 from "bs58";
import { PublicKey, Keypair, VersionedTransaction } from "@solana/web3.js";
import { connection} from "../config/connection.js";
import { readWallets, decodeSecretKeyToUint8, decodeSecretKey } from "../utils/fileManager.js";
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
