import { createApp } from "./app.js";
import { env } from "./lib/env.js";
import { prisma } from "./lib/prisma.js";
import { connectRedis, redis } from "./lib/redis.js";
import { captureUnexpectedError, initSentry } from "./lib/sentry.js";

initSentry();

async function main() {
  await prisma.$connect();
  try {
    await connectRedis();
    console.log("Redis connected");
  } catch (err) {
    console.warn("Redis unavailable at startup — continuing (OTP rate limits deferred)", err);
  }

  // Best-effort catalogue seed so Lock/Flex invest and legal screens work on cold DBs.
  try {
    const { ensureLockFlexRateBands } = await import("./services/lock-flex-rates.js");
    const { ensureLegalDocuments } = await import("./services/legal-documents.js");
    const { ensureB17ExploreCategories } = await import("./services/explore-categories.js");
    await ensureLockFlexRateBands();
    await ensureLegalDocuments();
    await ensureB17ExploreCategories();
  } catch (err) {
    console.warn("Catalogue ensure at startup failed — first request paths will retry", err);
  }

  const app = createApp();
  app.listen(env.PORT, () => {
    console.log(`kipit-api listening on http://localhost:${env.PORT}`);
  });
}

main().catch(async (err) => {
  console.error(err);
  captureUnexpectedError(err);
  await prisma.$disconnect().catch(() => undefined);
  await redis.quit().catch(() => undefined);
  process.exit(1);
});
