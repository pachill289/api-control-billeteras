import fs from "fs";
import bs58 from "bs58";

export const saveWallets = (newWallets) => {
  const wallets = readWallets(); // arreglo existente
  const merged = wallets.concat(newWallets); // concatenar correctamente
  fs.writeFileSync("wallets.json", JSON.stringify(merged, null, 2));
};

export const readWallets = () => {
  if (!fs.existsSync("wallets.json")) return [];
  return JSON.parse(fs.readFileSync("wallets.json"));
};

export function decodeSecretKey(secretKey) {

  if (!secretKey || typeof secretKey !== "string") {
    throw new Error("SecretKey vacía o inválida");
  }

  try {
    // Detectar Base64 → contiene "=" o "/" o "+"
    if (/[=+/]/.test(secretKey)) {
      const raw = Buffer.from(secretKey, "base64");
      return Uint8Array.from(raw);
    }

    // Sino → es Base58
    return Uint8Array.from(bs58.decode(secretKey));

  } catch (err) {
    throw new Error("No se pudo decodificar secretKey: " + err.message);
  }
}

/**
 * Convierte una secretKey en base58 → Uint8Array
 * Sirve para reconstruir el Keypair
 * 
 * @param {string} secretKeyBase58 - Clave privada en Base58
 * @returns {Uint8Array}
 */
export function decodeSecretKeyToUint8(secretKeyBase58) {
  if (!secretKeyBase58 || typeof secretKeyBase58 !== "string") {
    throw new Error("SecretKey inválida o vacía.");
  }

  try {
    const decoded = bs58.decode(secretKeyBase58);
    return Uint8Array.from(decoded);
  } catch (err) {
    throw new Error("No se pudo decodificar la secretKey Base58: " + err.message);
  }
}
