import { createApp } from "./app.js";
import { env } from "./lib/env.js";
import { prisma } from "./lib/prisma.js";
import { connectRedis, redis } from "./lib/redis.js";

async function main() {
  await prisma.$connect();
  try {
    await connectRedis();
    console.log("Redis connected");
  } catch (err) {
    console.warn("Redis unavailable at startup — continuing (OTP rate limits deferred)", err);
  }

  const app = createApp();
  app.listen(env.PORT, () => {
    console.log(`kipit-api listening on http://localhost:${env.PORT}`);
  });
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => undefined);
  await redis.quit().catch(() => undefined);
  process.exit(1);
});
