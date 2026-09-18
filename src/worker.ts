import { runMaturityEngine } from "./jobs/maturity.js";
import { prisma } from "./lib/prisma.js";
import { connectRedis } from "./lib/redis.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function msUntilMidnight() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
}

async function tick() {
  console.log("[worker] running maturity engine…");
  try {
    const result = await runMaturityEngine();
    console.log("[worker] maturity ok", result);
  } catch (err) {
    console.error("[worker] maturity failed", err);
  }
}

async function main() {
  await prisma.$connect();
  try {
    await connectRedis();
  } catch {
    console.warn("[worker] redis unavailable");
  }

  console.log("kipit-worker started — maturity scheduled for 00:00 local");
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), DAY_MS);
  }, msUntilMidnight());

  // Also allow an immediate run in development
  if (process.env.NODE_ENV !== "production") {
    console.log("[worker] scheduling first run in 5s (dev)");
    setTimeout(() => void tick(), 5000);
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
