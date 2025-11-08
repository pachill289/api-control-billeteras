import { createWallet, fundWallets, getWalletsAccountInfo, withdrawAllSOL, fundWalletsRandomPercentService, fundWalletsRandomService } from "../services/wallet.service.js";

// controlador para crear billeteras
export const createWallets = async (req, res) => {
  const { count } = req.body;
  let wallets = await createWallet(count);
  res.json({ message: "Billeteras creadas", billeteras:  wallets});
};

// controlador para llenar de fondos las billeteras
export const fundMany = async (req, res) => {
  const { privateKey, amount } = req.body;
  await fundWallets(privateKey, amount);
  res.json({ message: "Financiación completada" });
};

// controlador fondear wallets con porcentajes diferentes
export const fundWalletsRandomPercent = async (req, res) => {
  try {
    const data = await fundWalletsRandomPercentService(req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const fundWalletsRandom = async (req, res) => {
  try {
    const { funderPrivateKey, totalSol } = req.body;
    const response = await fundWalletsRandomService(funderPrivateKey, totalSol);
    res.json(response);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

// ver los datos de las billteras creadas
export const accountInfoJson = async (req, res) => {
  try {
    const { commitment } = req.body || {};
    const results = await getWalletsAccountInfo(commitment);
    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// controlador para enviar todo el SOL desde las billeteras que estan en wallets.json
export const withdrawAllFromWallets = async (req, res) => {
  try {
    const { destination } = req.body;

    if (!destination) {
      return res.status(400).json({ error: "Debes proporcionar 'destination'" });
    }

    const results = await withdrawAllSOL(destination);
    return res.status(200).json({ results });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};