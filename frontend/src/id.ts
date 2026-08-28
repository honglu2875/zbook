/** Create a UUID in browsers where randomUUID is unavailable on plain HTTP. */
export function createUuid(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    try {
      return webCrypto.randomUUID();
    } catch {
      // Some browsers expose randomUUID but reject it outside a secure context.
    }
  }

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    try {
      webCrypto.getRandomValues(bytes);
    } catch {
      fillWithMathRandom(bytes);
    }
  } else {
    fillWithMathRandom(bytes);
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function fillWithMathRandom(bytes: Uint8Array): void {
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
}
