import { getQuote, swap } from "@jup-ag/api";
import { connection, loadWallet } from "../config/connection.js";

// Comprar y vender tokens
export const buyToken = async (privateKey, mint, amountSol) => {
  const wallet = loadWallet(privateKey);

  const quote = await getQuote({
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: mint,
    amount: amountSol * 1e9,
    slippageBps: 300,
  });

  await swap(connection, wallet, quote);
};

export const sellToken = async (privateKey, mint, amountToken) => {
  const wallet = loadWallet(privateKey);

  const quote = await getQuote({
    inputMint: mint,
    outputMint: "So11111111111111111111111111111111111111112",
    amount: amountToken,
    slippageBps: 300,
  });

  await swap(connection, wallet, quote);
};
