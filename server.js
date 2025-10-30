import express from "express";
import walletRoutes  from "./src/routes/wallet.routes.js";
import tradeRoutes  from "./src/routes/trade.routes.js";
import dotenv from "dotenv";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
dotenv.config();
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json());

app.use("/wallets", walletRoutes );
app.use("/trade", tradeRoutes );

app.listen(PORT, () => console.log(`✅ Solana API listening on port: ${PORT}`));