import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { env } from "./env.js";

const BCRYPT_ROUNDS = 12;

export async function hashSecret(value: string) {
  return bcrypt.hash(value, BCRYPT_ROUNDS);
}

export async function verifySecret(value: string, hash: string) {
  return bcrypt.compare(value, hash);
}

export function weakPin(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return "PIN must be exactly 4 digits";
  if (/^(\d)\1{3}$/.test(pin)) return "PIN cannot use the same digit repeated";
  const seq = "0123456789012";
  const rev = "9876543210987";
  if (seq.includes(pin) || rev.includes(pin)) return "PIN cannot be sequential";
  const common = new Set(["0000", "1111", "1212", "1004", "2000", "2580"]);
  if (common.has(pin)) return "Choose a stronger PIN";
  return null;
}

export type AccessClaims = {
  sub: string;
  sid: string;
  typ: "access";
};

export function signAccessToken(userId: string, sessionId: string) {
  const claims: AccessClaims = { sub: userId, sid: sessionId, typ: "access" };
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL } as jwt.SignOptions);
}

export function signRefreshToken(userId: string, sessionId: string) {
  return jwt.sign(
    { sub: userId, sid: sessionId, typ: "refresh", jti: nanoid() },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_TTL } as jwt.SignOptions,
  );
}

export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessClaims;
  if (payload.typ !== "access") throw new Error("Invalid token type");
  return payload;
}

export type RefreshClaims = {
  sub: string;
  sid: string;
  typ: "refresh";
  jti: string;
};

export function verifyRefreshToken(token: string): RefreshClaims {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshClaims;
  if (payload.typ !== "refresh") throw new Error("Invalid token type");
  return payload;
}

export function nairaToKobo(naira: number) {
  return BigInt(Math.round(naira * 100));
}

export function koboToNaira(kobo: bigint) {
  return Number(kobo) / 100;
}

export function makeReferralCode(firstName: string) {
  const base = firstName.replace(/[^a-zA-Z]/g, "").slice(0, 4).toUpperCase() || "KIPT";
  return `${base}${nanoid(6).toUpperCase()}`;
}

export function makeReference(prefix: string) {
  return `${prefix}_${nanoid(12)}`;
}
