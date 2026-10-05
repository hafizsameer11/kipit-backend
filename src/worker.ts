import { runMaturityEngine } from "./jobs/maturity.js";
import { runKycVerificationJob } from "./jobs/kyc-verify.js";
import { runMonnifyVaPollJob } from "./jobs/monnify-va-poll.js";
import { runMarketingDigestJob } from "./jobs/marketing-digest.js";
import { runDueMarketingCampaignsJob } from "./jobs/marketing-campaigns.js";
import { runAutoInvestJob } from "./jobs/auto-invest.js";
import { runGiftExpiryJob } from "./jobs/gift-expiry.js";
import { runApplyRateChangesJob } from "./jobs/apply-rate-changes.js";
import { runWalletReconJob } from "./jobs/wallet-recon.js";
import { prisma } from "./lib/prisma.js";
import { connectRedis } from "./lib/redis.js";
import { getConfigJson } from "./services/admin-ops-store.js";
import {
  currentLagosHm,
  getOpsCutoffs,
  lagosDateKey,
} from "./services/system-settings.js";

const KYC_INTERVAL_MS = 60_000;
const MONNIFY_VA_INTERVAL_MS = 60_000;
const DIGEST_CHECK_MS = 60_000;
const CAMPAIGN_CHECK_MS = 60_000;
const AUTO_INVEST_INTERVAL_MS = 60_000;
const GIFT_EXPIRY_INTERVAL_MS = 60_000;
const RATE_APPLY_INTERVAL_MS = 60_000;
const SCHEDULE_CHECK_MS = 60_000;

let lastDigestDateKey = "";
let lastOpsDigestDateKey = "";
let lastMaturityDateKey = "";
let lastReconDateKey = "";

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

async function tickOpsDigest() {
  try {
    const target = "07:00";
    const nowHm = currentLagosHm();
    const dateKey = lagosDateKey();
    if (nowHm !== target || lastOpsDigestDateKey === dateKey) return;
    lastOpsDigestDateKey = dateKey;
    console.log("[worker] running ops digest…");
    const { runOpsDigestJob } = await import("./services/admin-alerts.js");
    const result = await runOpsDigestJob();
    console.log("[worker] ops digest ok", result);
  } catch (err) {
    console.error("[worker] ops digest failed", err);
  }
}

async function tickCampaigns() {
  try {
    const result = await runDueMarketingCampaignsJob();
    if (result.checked > 0) {
      console.log("[worker] marketing campaigns", result);
    }
  } catch (err) {
    console.error("[worker] marketing campaigns failed", err);
  }
}

async function tickMaturityScheduled() {
  try {
    const { interestAccrual } = await getOpsCutoffs();
    const nowHm = currentLagosHm();
    const dateKey = lagosDateKey();
    if (nowHm !== interestAccrual || lastMaturityDateKey === dateKey) return;
    lastMaturityDateKey = dateKey;
    console.log(`[worker] running maturity/interest engine @ ${interestAccrual} Lagos…`);
    const result = await runMaturityEngine();
    console.log("[worker] maturity ok", result);
  } catch (err) {
    console.error("[worker] maturity failed", err);
  }
}

async function tickWalletReconScheduled() {
  try {
    const { reconRun } = await getOpsCutoffs();
    const nowHm = currentLagosHm();
    const dateKey = lagosDateKey();
    if (nowHm !== reconRun || lastReconDateKey === dateKey) return;
    lastReconDateKey = dateKey;
    console.log(`[worker] running wallet-recon @ ${reconRun} Lagos…`);
    const result = await runWalletReconJob();
    console.log("[worker] wallet-recon ok", result);
  } catch (err) {
    console.error("[worker] wallet-recon failed", err);
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

async function tickAutoInvest() {
  try {
    const result = await runAutoInvestJob();
    if (result.due || result.ran || result.skipped || result.errors) {
      console.log("[worker] auto-invest", result);
    }
  } catch (err) {
    console.error("[worker] auto-invest failed", err);
  }
}

async function tickGiftExpiry() {
  try {
    const result = await runGiftExpiryJob();
    if (result.due || result.refunded || result.errors) {
      console.log("[worker] gift-expiry", result);
    }
  } catch (err) {
    console.error("[worker] gift-expiry failed", err);
  }
}

async function tickApplyRates() {
  try {
    const result = await runApplyRateChangesJob();
    if (result.repaired || result.applied) {
      console.log("[worker] apply-rates", result);
    }
  } catch (err) {
    console.error("[worker] apply-rates failed", err);
  }
}

async function main() {
  await prisma.$connect();
  try {
    await connectRedis();
  } catch {
    console.warn("[worker] redis unavailable");
  }

  const cutoffs = await getOpsCutoffs().catch(() => ({
    payoutBatch: "15:30",
    valueDate: "17:00",
    reconRun: "07:00",
    interestAccrual: "00:15",
  }));

  console.log(
    `kipit-worker started — maturity/interest @${cutoffs.interestAccrual} Lagos, recon @${cutoffs.reconRun} Lagos, digest @configured time, ops-digest @07:00 Lagos, campaigns every 60s, kyc-verify + monnify-va + auto-invest + gift-expiry + apply-rates every 60s`,
  );

  void tickKyc();
  setInterval(() => void tickKyc(), KYC_INTERVAL_MS);

  void tickMonnifyVa();
  setInterval(() => void tickMonnifyVa(), MONNIFY_VA_INTERVAL_MS);

  void tickAutoInvest();
  setInterval(() => void tickAutoInvest(), AUTO_INVEST_INTERVAL_MS);

  void tickGiftExpiry();
  setInterval(() => void tickGiftExpiry(), GIFT_EXPIRY_INTERVAL_MS);

  void tickApplyRates();
  setInterval(() => void tickApplyRates(), RATE_APPLY_INTERVAL_MS);

  void tickDigest();
  setInterval(() => void tickDigest(), DIGEST_CHECK_MS);

  void tickOpsDigest();
  setInterval(() => void tickOpsDigest(), DIGEST_CHECK_MS);

  void tickMaturityScheduled();
  setInterval(() => void tickMaturityScheduled(), SCHEDULE_CHECK_MS);

  void tickWalletReconScheduled();
  setInterval(() => void tickWalletReconScheduled(), SCHEDULE_CHECK_MS);

  void tickCampaigns();
  setInterval(() => void tickCampaigns(), CAMPAIGN_CHECK_MS);

  if (process.env.NODE_ENV !== "production") {
    console.log("[worker] scheduling first maturity run in 5s (dev)");
    setTimeout(() => void runMaturityEngine().then((r) => console.log("[worker] maturity ok", r)), 5000);
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
