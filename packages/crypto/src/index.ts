// Encrypts secrets stored in the control plane (vendor connection strings) with
// AES-256-GCM through WebCrypto, so the same code runs in Workers and Node. The key
// lives only in Worker and CI secrets. Each secret is bound to a context string (the
// vendor ID), so a ciphertext copied onto another vendor's row won't decrypt.
//
// Format: v1.<iv, base64url>.<ciphertext + tag, base64url>

const VERSION = "v1";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A new random 256-bit key, base64-encoded, for VENDOR_DB_KEY. */
export function generateKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

/** A random password: `bytes` random bytes, base64url (no characters that need quoting). */
export function randomPassword(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key.trim());
  if (raw.length !== 32) throw new Error("The encryption key must be 32 bytes, base64-encoded.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(key: CryptoKey, plaintext: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

export async function decryptSecret(key: CryptoKey, token: string, context: string): Promise<string> {
  const [version, iv, sealed] = token.split(".");
  if (version !== VERSION || !iv || !sealed) throw new Error("Not an encrypted secret this code can read.");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv), additionalData: new TextEncoder().encode(context) },
      key,
      fromBase64(sealed),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Wrong key, wrong context or tampered ciphertext: GCM can't tell which.
    throw new Error("Could not decrypt the secret: wrong key, wrong vendor, or the value was altered.");
  }
}
