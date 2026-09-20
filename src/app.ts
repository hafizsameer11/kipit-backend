import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { errorHandler, AppError, asyncHandler } from "./lib/errors.js";
import { authRouter } from "./routes/auth.js";
import { walletRouter } from "./routes/wallet.js";
import { meRouter } from "./routes/me.js";
import { kycRouter } from "./routes/kyc.js";
import { investRouter } from "./routes/invest.js";
import { exploreRouter } from "./routes/explore.js";
import { withdrawRouter } from "./routes/withdraw.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { settingsRouter } from "./routes/settings.js";
import { adminRouter } from "./routes/admin.js";
import { adminResourcesRouter } from "./routes/admin-resources.js";
import { adminConsoleRouter } from "./routes/admin-console.js";
import { giftsRouter } from "./routes/gifts.js";
import { chatRouter } from "./routes/chat.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { runMaturityEngine } from "./jobs/maturity.js";
import type { AuthRequest } from "./middleware/auth.js";
import { requireAuth } from "./middleware/auth.js";
import { env, monnifyUseMock, paystackUseMock } from "./lib/env.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));

  // Webhooks need raw body for signature verification — mount before JSON parser.
  app.use(
    "/v1/webhooks",
    express.raw({ type: "application/json" }),
    (req, _res, next) => {
      const buf = req.body as Buffer;
      const rawBody = Buffer.isBuffer(buf) ? buf.toString("utf8") : "";
      (req as typeof req & { rawBody?: string }).rawBody = rawBody;
      try {
        req.body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return next(new AppError(400, "Invalid JSON", "BAD_JSON"));
      }
      next();
    },
    webhooksRouter,
  );

  app.use(express.json({ limit: "2mb" }));
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "kipit-api",
      version: "0.3.0",
      time: new Date().toISOString(),
    });
  });

  app.get("/v1", (_req, res) => {
    res.json({
      name: "Kipit API",
      version: "v1",
      surfaces: ["consumer", "admin", "chat", "payments"],
      payments: {
        monnify: true,
        paystack: true,
        mode: env.PAYMENTS_MODE,
        monnifyMock: monnifyUseMock(),
        paystackMock: paystackUseMock(),
      },
    });
  });

  app.use("/v1/auth", authRouter);
  app.use("/v1/wallet", walletRouter);
  app.use("/v1/me", meRouter);
  app.use("/v1/kyc", kycRouter);
  app.use("/v1/invest", investRouter);
  app.use("/v1/explore", exploreRouter);
  app.use("/v1/withdraw", withdrawRouter);
  app.use("/v1/portfolio", portfolioRouter);
  app.use("/v1/settings", settingsRouter);
  app.use("/v1/chat", chatRouter);
  app.use("/v1/gifts", giftsRouter);
  app.use("/v1/admin", adminRouter);
  app.use("/v1/admin", adminResourcesRouter);
  app.use("/v1/admin", adminConsoleRouter);

  app.post(
    "/v1/admin/jobs/maturity/run",
    asyncHandler(async (_req, res) => {
      if (process.env.NODE_ENV === "production") {
        return res.status(404).json({ error: { message: "Not found" } });
      }
      const result = await runMaturityEngine();
      res.json({ data: result });
    }),
  );

  app.get(
    "/v1/home/feed",
    requireAuth,
    asyncHandler(async (_req: AuthRequest, res) => {
      const { prisma } = await import("./lib/prisma.js");
      const cards = await prisma.feedCard.findMany({
        where: { active: true },
        orderBy: { sortOrder: "asc" },
      });
      res.json({ data: cards });
    }),
  );

  app.use(errorHandler);
  return app;
}
