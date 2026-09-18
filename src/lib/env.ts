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
   * When true (default in sandbox without keys), Monnify/Paystack calls are
   * simulated locally. Set false and provide keys to hit real sandbox APIs.
   */
  PAYMENTS_MOCK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  APP_BASE_URL: z.string().default("http://localhost:4000"),
  WEB_APP_URL: z.string().default("http://localhost:8080"),

  MONNIFY_API_KEY: z.string().optional().default(""),
  MONNIFY_SECRET_KEY: z.string().optional().default(""),
  MONNIFY_CONTRACT_CODE: z.string().optional().default(""),
  MONNIFY_BASE_URL: z.string().optional().default(""),

  PAYSTACK_SECRET_KEY: z.string().optional().default(""),
  PAYSTACK_PUBLIC_KEY: z.string().optional().default(""),
  PAYSTACK_BASE_URL: z.string().optional().default(""),
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

export function paymentsUseMock() {
  if (env.PAYMENTS_MOCK) return true;
  // Auto-mock when keys are missing so local/dev always works.
  const hasMonnify = Boolean(env.MONNIFY_API_KEY && env.MONNIFY_SECRET_KEY && env.MONNIFY_CONTRACT_CODE);
  const hasPaystack = Boolean(env.PAYSTACK_SECRET_KEY);
  return !(hasMonnify || hasPaystack);
}
