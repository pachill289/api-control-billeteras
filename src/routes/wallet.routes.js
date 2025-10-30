import express from "express";
import { createWallets, fundMany, withdrawAllFromWallets, accountInfoJson } from "../controllers/wallet.controller.js";

// rutas
const router = express.Router();
router.post("/create-wallets", createWallets);
router.post("/info", accountInfoJson);
router.post("/fund-wallets", fundMany);
router.post("/withdraw-to-wallet", withdrawAllFromWallets);

export default router;