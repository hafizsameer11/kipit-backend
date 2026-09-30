import { runMaturityEngine } from "./jobs/maturity.js";
import { runKycVerificationJob } from "./jobs/kyc-verify.js";
import { runMonnifyVaPollJob } from "./jobs/monnify-va-poll.js";
import { runMarketingDigestJob } from "./jobs/marketing-digest.js";
import { prisma } from "./lib/prisma.js";
import { connectRedis } from "./lib/redis.js";
import { getConfigJson } from "./services/admin-ops-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const KYC_INTERVAL_MS = 60_000;
const MONNIFY_VA_INTERVAL_MS = 60_000;
const DIGEST_CHECK_MS = 60_000;

function msUntilMidnight() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
}

/** HH:MM in Africa/Lagos (or server local if Intl missing). */
function currentLagosHm(): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Lagos",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${hour}:${minute}`;
  } catch {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

function lagosDateKey(): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

let lastDigestDateKey = "";

async function tickDigest() {
  try {
    const digest = await getConfigJson("marketing.digest", {
      enabled: true,
      sendTime: "07:30",
    });
    if (!digest.enabled) return;
    const target = String(digest.sendTime || "07:30").slice(0, 5);
    const nowHm = currentLagosHm();
    const dateKey = lagosDateKey();
    if (nowHm !== target || lastDigestDateKey === dateKey) return;
    lastDigestDateKey = dateKey;
    console.log("[worker] running marketing digest…");
    const result = await runMarketingDigestJob({ manual: false });
    console.log("[worker] marketing digest ok", result);
  } catch (err) {
    console.error("[worker] marketing digest failed", err);
  }
}

async function tickMaturity() {
  console.log("[worker] running maturity engine…");
  try {
    const result = await runMaturityEngine();
    console.log("[worker] maturity ok", result);
  } catch (err) {
    console.error("[worker] maturity failed", err);
  }
}

async function tickKyc() {
  try {
    const result = await runKycVerificationJob();
    if (result.approved || result.rejected || result.retry || result.errors) {
      console.log("[worker] kyc-verify", result);
    }
  } catch (err) {
    console.error("[worker] kyc-verify failed", err);
  }
}

async function tickMonnifyVa() {
  try {
    const result = await runMonnifyVaPollJob();
    if (result.credited || result.expired || result.errors) {
      console.log("[worker] monnify-va-poll", result);
    }
  } catch (err) {
    console.error("[worker] monnify-va-poll failed", err);
  }
}

async function main() {
  await prisma.$connect();
  try {
    await connectRedis();
  } catch {
    console.warn("[worker] redis unavailable");
  }

  console.log(
    "kipit-worker started — maturity @00:00, digest @configured time, kyc-verify + monnify-va every 60s",
  );

  setTimeout(() => {
    void tickMaturity();
    setInterval(() => void tickMaturity(), DAY_MS);
  }, msUntilMidnight());

  void tickKyc();
  setInterval(() => void tickKyc(), KYC_INTERVAL_MS);

  void tickMonnifyVa();
  setInterval(() => void tickMonnifyVa(), MONNIFY_VA_INTERVAL_MS);

  void tickDigest();
  setInterval(() => void tickDigest(), DIGEST_CHECK_MS);

  if (process.env.NODE_ENV !== "production") {
    console.log("[worker] scheduling first maturity run in 5s (dev)");
    setTimeout(() => void tickMaturity(), 5000);
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
