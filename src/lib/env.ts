import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("30d"),
  DEMO_OTP: z.string().default("123456"),

  /** smtp (Hostinger) now; set resend later when activating Resend */
  EMAIL_PROVIDER: z.enum(["smtp", "resend", "console"]).default("smtp"),
  EMAIL_FROM: z.string().optional().default(""),
  /** Hostinger typically: smtp.hostinger.com, port 465 (SSL) or 587 (STARTTLS) */
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  /** Reserved for later */
  RESEND_API_KEY: z.string().optional().default(""),

  /** sandbox = use provider sandbox URLs; live = production URLs */
  PAYMENTS_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
  /**
   * Global mock switch (mainly Monnify). Paystack uses real API whenever
   * PAYSTACK_SECRET_KEY is set (sk_test_… or sk_live_…), unless PAYSTACK_MOCK=true.
   */
  PAYMENTS_MOCK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  PAYSTACK_MOCK: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),

  APP_BASE_URL: z.string().default("http://localhost:4000"),
  WEB_APP_URL: z.string().default("http://localhost:8080"),

  MONNIFY_API_KEY: z.string().optional().default(""),
  MONNIFY_SECRET_KEY: z.string().optional().default(""),
  MONNIFY_CONTRACT_CODE: z.string().optional().default(""),
  MONNIFY_BASE_URL: z.string().optional().default(""),

  PAYSTACK_SECRET_KEY: z.string().optional().default(""),
  PAYSTACK_PUBLIC_KEY: z.string().optional().default(""),
  PAYSTACK_BASE_URL: z.string().optional().default(""),

  /**
   * Prembly identity verification (BVN / NIN).
   * Latest docs: only `x-api-key` is required — no app-id header.
   * https://docs.prembly.com/docs/authentication
   */
  PREMBLY_API_KEY: z.string().optional().default(""),
  PREMBLY_BASE_URL: z.string().optional().default("https://api.prembly.com"),
  /** Force mock even when PREMBLY_API_KEY is set. Default: mock when key is empty. */
  PREMBLY_MOCK: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

export const env = envSchema.parse(process.env);

export function monnifyBaseUrl() {
  if (env.MONNIFY_BASE_URL) return env.MONNIFY_BASE_URL.replace(/\/$/, "");
  return env.PAYMENTS_MODE === "live"
    ? "https://api.monnify.com"
    : "https://sandbox.monnify.com";
}

export function paystackBaseUrl() {
  if (env.PAYSTACK_BASE_URL) return env.PAYSTACK_BASE_URL.replace(/\/$/, "");
  return "https://api.paystack.co";
}

/** True when Monnify should be simulated (no keys or PAYMENTS_MOCK). */
export function monnifyUseMock() {
  if (env.PAYMENTS_MOCK) return true;
  return !(
    env.MONNIFY_API_KEY &&
    env.MONNIFY_SECRET_KEY &&
    env.MONNIFY_CONTRACT_CODE
  );
}

/**
 * True when Paystack should be simulated.
 * With sk_test_ / sk_live_ in PAYSTACK_SECRET_KEY → real Paystack API.
 */
export function paystackUseMock() {
  if (env.PAYSTACK_MOCK === true) return true;
  if (env.PAYSTACK_MOCK === false) return !env.PAYSTACK_SECRET_KEY;
  // Default: real Paystack whenever a secret key is present (test or live).
  return !Boolean(env.PAYSTACK_SECRET_KEY?.trim());
}

/** @deprecated Prefer monnifyUseMock / paystackUseMock — true only if both would mock. */
export function paymentsUseMock() {
  return monnifyUseMock() && paystackUseMock();
}

/** True when Prembly should be simulated (no API key or PREMBLY_MOCK=true). */
export function premblyUseMock() {
  if (env.PREMBLY_MOCK === true) return true;
  if (env.PREMBLY_MOCK === false) return !env.PREMBLY_API_KEY?.trim();
  return !Boolean(env.PREMBLY_API_KEY?.trim());
}

export function premblyBaseUrl() {
  return (env.PREMBLY_BASE_URL || "https://api.prembly.com").replace(/\/$/, "");
}
