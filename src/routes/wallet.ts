import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { requireKyc } from "../middleware/kyc.js";
import { creditWalletDeposit, getWalletBalanceKobo } from "../services/ledger.js";
import { koboToNaira } from "../lib/crypto.js";
import { writeAudit } from "../services/audit.js";
import {
  confirmBankTransfer,
  confirmCardPayment,
  getOrCreateVirtualAccount,
  initializeCardFunding,
  listSavedCards,
} from "../services/payments/funding.js";
import { env } from "../lib/env.js";

export const walletRouter = Router();

walletRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const balanceKobo = await getWalletBalanceKobo(req.userId!);
    res.json({
      data: {
        currency: "NGN",
        balanceKobo: balanceKobo.toString(),
        balance: koboToNaira(balanceKobo),
        earnsInterest: false,
        paymentsMode: env.PAYMENTS_MODE,
      },
    });
  }),
);

/** Dedicated Monnify virtual account for bank-transfer funding. */
walletRouter.get(
  "/virtual-account",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    const va = await getOrCreateVirtualAccount(req.userId!);
    res.json({
      data: {
        bank: va.bankName,
        accountNumber: va.accountNumber,
        accountName: va.accountName,
        bankCode: va.bankCode,
        provider: va.provider,
      },
    });
  }),
);

walletRouter.get(
  "/cards",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    res.json({ data: await listSavedCards(req.userId!) });
  }),
);

/** Start Paystack card charge (sandbox mock works without keys). */
walletRouter.post(
  "/fund/card/initialize",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        amount: z.number().positive(),
        cardTokenId: z.string().optional(),
        saveCard: z.boolean().optional(),
      })
      .parse(req.body);
    const data = await initializeCardFunding({
      userId: req.userId!,
      amountNaira: body.amount,
      cardTokenId: body.cardTokenId,
      saveCard: body.saveCard,
    });
    res.status(201).json({ data });
  }),
);

/** Verify + credit after card authorization (or sandbox mock success). */
walletRouter.post(
  "/fund/card/confirm",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z.object({ reference: z.string().min(4) }).parse(req.body);
    const data = await confirmCardPayment({ userId: req.userId!, reference: body.reference });
    res.json({ data });
  }),
);

/**
 * User confirms they sent a bank transfer.
 * In sandbox mode the wallet is credited immediately (simulates Monnify webhook).
 * In live mode the intent stays pending until the Monnify webhook arrives.
 */
walletRouter.post(
  "/fund/transfer/confirm",
  requireAuth,
  requireKyc("TIER_1"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        amount: z.number().positive(),
        simulate: z.boolean().optional(),
      })
      .parse(req.body);
    const data = await confirmBankTransfer({
      userId: req.userId!,
      amountNaira: body.amount,
      forceSimulate: body.simulate,
    });
    res.status(201).json({ data });
  }),
);

/**
 * Dev/sandbox helper — creates a PaymentIntent + credits wallet (mock provider).
 * Prefer /fund/transfer/confirm or /fund/card/* in product flows.
 */
walletRouter.post(
  "/sandbox/deposit",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    if (env.NODE_ENV === "production" && env.PAYMENTS_MODE === "live") {
      throw new AppError(404, "Not found", "NOT_FOUND");
    }
    const body = z
      .object({
        amount: z.number().positive(),
        idempotencyKey: z.string().min(8),
        provider: z.enum(["monnify", "paystack", "manual"]).default("manual"),
      })
      .parse(req.body);

    const { makeReference, nairaToKobo: toKobo } = await import("../lib/crypto.js");
    const { prisma } = await import("../lib/prisma.js");
    const amountKobo = toKobo(body.amount);
    const reference = body.idempotencyKey.startsWith("sbx-")
      ? body.idempotencyKey
      : `sbx-${makeReference("SBX")}`;

    const existing = await prisma.paymentIntent.findUnique({ where: { reference } });
    if (existing?.status === "SUCCESS") {
      const balanceKobo = await getWalletBalanceKobo(req.userId!);
      res.json({
        data: {
          alreadyProcessed: true,
          reference,
          wallet: { balance: koboToNaira(balanceKobo), balanceKobo: balanceKobo.toString() },
        },
      });
      return;
    }

    const intent =
      existing ??
      (await prisma.paymentIntent.create({
        data: {
          userId: req.userId!,
          provider: body.provider === "manual" ? "mock" : body.provider,
          channel: "sandbox",
          amountKobo,
          reference,
          providerRef: `mock-${reference}`,
          metadata: { mock: true, source: "sandbox_deposit" },
        },
      }));

    const entry = await creditWalletDeposit({
      userId: req.userId!,
      amountKobo,
      idempotencyKey: `pay-${reference}`,
      description: `Sandbox ${body.provider} deposit`,
      metadata: { provider: body.provider, mock: true },
    });

    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: "SUCCESS", completedAt: new Date(), providerRef: `mock-${reference}` },
    });

    await writeAudit({
      actorUserId: req.userId,
      action: "wallet.sandbox_deposit",
      entityType: "PaymentIntent",
      entityId: intent.id,
      after: { amount: body.amount, provider: body.provider, mock: true },
    });

    const balanceKobo = await getWalletBalanceKobo(req.userId!);
    res.status(201).json({
      data: {
        intentId: intent.id,
        reference,
        entry: {
          id: entry.id,
          reference: entry.reference,
          kind: entry.kind,
        },
        wallet: {
          currency: "NGN",
          balanceKobo: balanceKobo.toString(),
          balance: koboToNaira(balanceKobo),
        },
        mock: true,
      },
    });
  }),
);
