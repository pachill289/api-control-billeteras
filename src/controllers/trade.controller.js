import { buyTokenService, buyTokenAllWalletsService, sellTokenAllWalletsService, buyTokenAllWalletsUniquePercentService  } from "../services/trade.service.js";

export const buyToken = async (req, res) => {
  try {
    const data = await buyTokenService(req.body);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const buyTokenAllWallets = async (req, res) => {
  try {
    const data = await buyTokenAllWalletsService(req.body);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const buyTokenAllWalletsUniquePercent = async (req, res) => {
  try {
    const data = await buyTokenAllWalletsUniquePercentService(req.body);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
};

export const sellTokenAllWallets = async (req, res) => {
  try {
    const result = await sellTokenAllWalletsService(req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
