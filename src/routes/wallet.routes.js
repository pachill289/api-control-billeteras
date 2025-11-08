import express from "express";
import { createWallets, fundMany, withdrawAllFromWallets, accountInfoJson, fundWalletsRandomPercent, fundWalletsRandom } from "../controllers/wallet.controller.js";

// rutas
const router = express.Router();
router.post("/create-wallets", createWallets);
router.post("/info", accountInfoJson);
router.post("/fund-wallets", fundMany);
router.post("/fund-wallets-random-percent", fundWalletsRandomPercent);
router.post("/fund-wallets-random", fundWalletsRandom);
router.post("/withdraw-to-wallet", withdrawAllFromWallets);

export default router;