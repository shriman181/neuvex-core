import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateKey, importKey, randomPassword } from "../src/index.js";

const URL_A = "postgresql://neuvex_gateway:pw@ep-a-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

describe("secrets", () => {
  it("round-trips, with a fresh IV every time", async () => {
    const key = await importKey(generateKey());
    const a = await encryptSecret(key, URL_A, "vendor-a");
    const b = await encryptSecret(key, URL_A, "vendor-a");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(a).not.toContain("neuvex_gateway");
    expect(await decryptSecret(key, a, "vendor-a")).toBe(URL_A);
  });

  it("won't decrypt for another vendor, with another key, or after tampering", async () => {
    const key = await importKey(generateKey());
    const token = await encryptSecret(key, URL_A, "vendor-a");
    await expect(decryptSecret(key, token, "vendor-b")).rejects.toThrow(/Could not decrypt/);
    await expect(decryptSecret(await importKey(generateKey()), token, "vendor-a")).rejects.toThrow(/Could not decrypt/);
    const [v, iv, sealed] = token.split(".");
    const c = sealed!.charAt(5);
    const flipped = `${v}.${iv}.${sealed!.slice(0, 5)}${c === "A" ? "B" : "A"}${sealed!.slice(6)}`;
    await expect(decryptSecret(key, flipped, "vendor-a")).rejects.toThrow(/Could not decrypt/);
    await expect(decryptSecret(key, "plain-text", "vendor-a")).rejects.toThrow(/Not an encrypted secret/);
  });

  it("rejects keys of the wrong size", async () => {
    await expect(importKey(btoa("too short"))).rejects.toThrow(/32 bytes/);
  });

  it("makes URL-safe passwords", () => {
    const p = randomPassword();
    expect(p).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomPassword()).not.toBe(p);
  });
});
