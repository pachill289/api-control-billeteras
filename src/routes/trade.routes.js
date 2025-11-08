import { Router } from "express";
import { buyToken, buyTokenAllWallets, sellTokenAllWallets, buyTokenAllWalletsUniquePercent  } from "../controllers/trade.controller.js";

const router = Router();

router.post("/buy-token", buyToken);
router.post("/buy-token-all-wallets", buyTokenAllWallets);
router.post("/buy-token-all-wallets-unique-percent", buyTokenAllWalletsUniquePercent);
router.post("/sell-token-all-wallets", sellTokenAllWallets);

export default router;