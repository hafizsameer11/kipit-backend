import { Router } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { asyncHandler, AppError } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { requireKyc } from "../middleware/kyc.js";
import { prisma } from "../lib/prisma.js";
import { koboToNaira, nairaToKobo } from "../lib/crypto.js";
import { verifyTransactionPin } from "../services/auth.js";
import { debitWallet, interestForPeriod } from "../services/money.js";
import { writeAudit } from "../services/audit.js";
import { asProductDetails } from "../lib/product-details.js";

export const exploreRouter = Router();

exploreRouter.get(
  "/categories",
  asyncHandler(async (_req, res) => {
    const cats = await prisma.productCategory.findMany({
      orderBy: { sortOrder: "asc" },
      include: { _count: { select: { products: true } } },
    });
    res.json({
      data: cats.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        productCount: c._count.products,
      })),
    });
  }),
);

exploreRouter.get(
  "/products",
  asyncHandler(async (req, res) => {
    const categorySlug = typeof req.query.category === "string" ? req.query.category : undefined;
    const products = await prisma.product.findMany({
      where: categorySlug ? { category: { slug: categorySlug } } : undefined,
      include: { category: true },
      orderBy: { name: "asc" },
    });
    res.json({
      data: products.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        blurb: p.blurb,
        description: p.description,
        ratePct: p.rateBps / 100,
        tenorDays: p.tenorDays,
        minimum: koboToNaira(p.minimumKobo),
        availability: p.availability,
        issuer: p.issuer,
        largeTicket: p.largeTicket || p.minimumKobo >= 500_000_000n,
        category: { slug: p.category.slug, name: p.category.name },
        termsVersion: p.termsVersion,
        details: asProductDetails(p.details),
      })),
    });
  }),
);

exploreRouter.get(
  "/products/:idOrSlug",
  asyncHandler(async (req, res) => {
    const key = String(req.params.idOrSlug);
    const product = await prisma.product.findFirst({
      where: { OR: [{ id: key }, { slug: key }] },
      include: { category: true },
    });
    if (!product) throw new AppError(404, "Product not found", "PRODUCT_NOT_FOUND");
    res.json({
      data: {
        id: product.id,
        slug: product.slug,
        name: product.name,
        blurb: product.blurb,
        description: product.description,
        ratePct: product.rateBps / 100,
        tenorDays: product.tenorDays,
        minimum: koboToNaira(product.minimumKobo),
        availability: product.availability,
        issuer: product.issuer,
        largeTicket: product.largeTicket || product.minimumKobo >= 500_000_000n,
        category: { slug: product.category.slug, name: product.category.name },
        termsVersion: product.termsVersion,
        details: asProductDetails(product.details),
      },
    });
  }),
);

exploreRouter.post(
  "/products/:id/subscribe",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        amount: z.number().positive(),
        pin: z.string().length(4),
        idempotencyKey: z.string().min(8),
      })
      .parse(req.body);

    const product = await prisma.product.findUnique({ where: { id: String(req.params.id) } });
    if (!product) throw new AppError(404, "Product not found", "PRODUCT_NOT_FOUND");
    if (product.availability === "CLOSED" || product.availability === "COMING_SOON") {
      throw new AppError(400, "Product unavailable", "PRODUCT_UNAVAILABLE");
    }
    if (product.largeTicket || product.minimumKobo >= 500_000_000n) {
      throw new AppError(400, "Use request-access for large-ticket products", "LARGE_TICKET");
    }

    const amountKobo = nairaToKobo(body.amount);
    if (amountKobo < product.minimumKobo) {
      throw new AppError(400, "Below product minimum", "BELOW_MINIMUM");
    }

    await verifyTransactionPin(req.userId!, body.pin);

    await prisma.consentAcceptance.create({
      data: {
        userId: req.userId!,
        docKey: `product:${product.slug}`,
        version: product.termsVersion,
      },
    });

    const tag = `explore_${nanoid(10)}`;
    const account = await prisma.ledgerAccount.create({
      data: {
        userId: req.userId!,
        type: "USER_PLACEMENT",
        tag,
        currency: "NGN",
        balanceKobo: 0n,
      },
    });

    await debitWallet({
      userId: req.userId!,
      amountKobo,
      kind: "PLACEMENT",
      idempotencyKey: body.idempotencyKey,
      description: `Explore: ${product.name}`,
      creditAccountId: account.id,
    });

    const maturityDate = new Date();
    maturityDate.setDate(maturityDate.getDate() + product.tenorDays);

    const placement = await prisma.placement.create({
      data: {
        userId: req.userId!,
        kind: "EXPLORE",
        productId: product.id,
        name: product.name,
        principalKobo: amountKobo,
        rateBps: product.rateBps,
        tenorDays: product.tenorDays,
        maturityDate,
        ledgerAccountId: account.id,
      },
    });

    res.status(201).json({
      data: {
        id: placement.id,
        productId: product.id,
        amount: body.amount,
        maturityDate: maturityDate.toISOString().slice(0, 10),
        expectedInterest: koboToNaira(
          interestForPeriod(amountKobo, product.rateBps, product.tenorDays),
        ),
      },
    });
  }),
);

exploreRouter.post(
  "/products/:id/request-access",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z.object({ message: z.string().optional() }).parse(req.body);
    const product = await prisma.product.findUnique({ where: { id: String(req.params.id) } });
    if (!product) throw new AppError(404, "Product not found", "PRODUCT_NOT_FOUND");
    const row = await prisma.productAccessRequest.create({
      data: { productId: product.id, userId: req.userId!, message: body.message },
    });
    await writeAudit({
      actorUserId: req.userId,
      action: "product.request_access",
      entityType: "ProductAccessRequest",
      entityId: row.id,
    });
    res.status(201).json({ data: { id: row.id, status: "submitted" } });
  }),
);
