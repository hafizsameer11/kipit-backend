import { runMaturityEngine } from "./jobs/maturity.js";
import { runKycVerificationJob } from "./jobs/kyc-verify.js";
import { runMonnifyVaPollJob } from "./jobs/monnify-va-poll.js";
import { prisma } from "./lib/prisma.js";
import { connectRedis } from "./lib/redis.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const KYC_INTERVAL_MS = 60_000;
const MONNIFY_VA_INTERVAL_MS = 60_000;

function msUntilMidnight() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
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

  console.log("kipit-worker started — maturity @00:00, kyc-verify + monnify-va every 60s");

  setTimeout(() => {
    void tickMaturity();
    setInterval(() => void tickMaturity(), DAY_MS);
  }, msUntilMidnight());

  void tickKyc();
  setInterval(() => void tickKyc(), KYC_INTERVAL_MS);

  void tickMonnifyVa();
  setInterval(() => void tickMonnifyVa(), MONNIFY_VA_INTERVAL_MS);

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
