import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { authenticator } from "otplib";
import { env } from "../lib/env.js";

authenticator.options = { window: 1, step: 30 };

const ISSUER = "Kipit Admin";

function encKey() {
  return scryptSync(env.JWT_ACCESS_SECRET, "kipit-admin-totp-v1", 32);
}

/** Encrypt a TOTP secret for at-rest storage. */
export function encryptTotpSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function decryptTotpSecret(payload: string): string {
  const buf = Buffer.from(payload, "base64url");
  if (buf.length < 29) throw new Error("Invalid TOTP secret payload");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function generateTotpSecret() {
  return authenticator.generateSecret();
}

export function totpKeyUri(email: string, secret: string) {
  return authenticator.keyuri(email, ISSUER, secret);
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const token = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(token)) return false;
  try {
    return authenticator.check(token, secret);
  } catch {
    return false;
  }
}

export function formatTotpSecretDisplay(secret: string) {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}
