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

export function generatePercentages(count = 20, min = 1, max = 8) {
  let remaining = 100;
  let result = [];

  for (let i = 0; i < count; i++) {
    let slotsLeft = count - i - 1;
    let maxAllowed = Math.min(max, remaining - (slotsLeft * min));
    let minAllowed = min;

    let p = Math.floor(Math.random() * (maxAllowed - minAllowed + 1)) + minAllowed;
    result.push(p);
    remaining -= p;
  }

  // Ajuste final para evitar pequeños desbalances por redondeo
  if (remaining !== 0) {
    result[result.length - 1] += remaining;
  }

  return result;
}

// Generador de porcentajes enteros en rango 1–10 que suman 100
export const generateBoundedIntPartition = (N, total, minV = 1, maxV = 10) => {
  const res = new Array(N).fill(0);
  let remaining = total;

  for (let i = 0; i < N; i++) {
    const remainingPositions = N - i;
    const minAllowed = Math.max(minV, remaining - (remainingPositions - 1) * maxV);
    const maxAllowed = Math.min(maxV, remaining - (remainingPositions - 1) * minV);
    const val = Math.floor(Math.random() * (maxAllowed - minAllowed + 1)) + minAllowed;

    res[i] = val;
    remaining -= val;
  }
  return res;
};


// Genera N porcentajes distintos que suman 100 usando progresión aritmética.
// Devuelve array de porcentajes (float) con 6 decimales exactos que suman 100.
export const generateUniquePercentages = (N) => {
  if (N <= 0) throw new Error("N debe ser positivo");

  // intentamos una diferencia d = 0.01 por defecto (muy pequeña para evitar negativos)
  // y calculamos 'a' (primer término) de la progresión aritmética:
  // Sum = N*a + d*N*(N-1)/2 = 100  -> a = (100 - d*N*(N-1)/2) / N
  // Si a <= 0 reducimos d hasta que a > 0 (linealmente).
  let d = 0.01;
  const maxIter = 1000;
  let iter = 0;
  let a = (100 - d * (N * (N - 1) / 2)) / N;

  while (a <= 0 && iter < maxIter) {
    d = d / 2; // reducimos d
    a = (100 - d * (N * (N - 1) / 2)) / N;
    iter++;
  }
  if (a <= 0) {
    throw new Error(`No se pudo generar porcentajes distintos positivos para N=${N}. Usa menos wallets o permite porcentajes iguales.`);
  }

  // construimos la progresión
  const raw = Array.from({ length: N }, (_, i) => a + d * i);

  // redondeo a 6 decimales y corrección del residual
  const rounded = raw.map(x => Math.round(x * 1e6) / 1e6);
  const sumRounded = rounded.reduce((s, v) => s + v, 0);
  const residual = Math.round((100 - sumRounded) * 1e6) / 1e6;

  // aplicamos el residual al último elemento (podría ser muy pequeño)
  rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + residual) * 1e6) / 1e6;

  // última verificación (por precaución numérica)
  const finalSum = Math.round(rounded.reduce((s, v) => s + v, 0) * 1e6) / 1e6;
  if (Math.abs(finalSum - 100) > 1e-6) {
    throw new Error("Error al ajustar porcentajes: la suma no es exactamente 100%");
  }

  return rounded;
};
