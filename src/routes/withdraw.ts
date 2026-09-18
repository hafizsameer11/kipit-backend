import { Router } from "express";
import { z } from "zod";
import { asyncHandler, AppError } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { requireKyc } from "../middleware/kyc.js";
import { prisma } from "../lib/prisma.js";
import { koboToNaira, makeReference, nairaToKobo } from "../lib/crypto.js";
import { verifyTransactionPin } from "../services/auth.js";
import { debitWallet, ensureSystemAccount, getWalletBalanceKobo } from "../services/money.js";
import { writeAudit } from "../services/audit.js";

export const withdrawRouter = Router();

const BANKS = [
  { code: "058", name: "GTBank" },
  { code: "033", name: "UBA" },
  { code: "011", name: "First Bank" },
  { code: "057", name: "Zenith Bank" },
  { code: "032", name: "Union Bank" },
  { code: "214", name: "FCMB" },
];

withdrawRouter.get(
  "/banks",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ data: BANKS });
  }),
);

withdrawRouter.get(
  "/accounts",
  requireAuth,
  requireKyc("TIER_2"),
  asyncHandler(async (req: AuthRequest, res) => {
    const accounts = await prisma.payoutBank.findMany({ where: { userId: req.userId! } });
    res.json({
      data: accounts.map((a) => ({
        id: a.id,
        bankCode: a.bankCode,
        bankName: a.bankName,
        accountNumber: a.accountNumber,
        accountName: a.accountName,
        nameMatched: a.nameMatched,
      })),
    });
  }),
);

withdrawRouter.post(
  "/accounts",
  requireAuth,
  requireKyc("TIER_2"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        bankCode: z.string().min(2),
        accountNumber: z.string().min(10).max(10),
      })
      .parse(req.body);

    const bank = BANKS.find((b) => b.code === body.bankCode);
    if (!bank) throw new AppError(400, "Unknown bank", "BANK_UNKNOWN");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    // Sandbox NIBSS name enquiry — match against user legal name
    const accountName = `${user.firstName} ${user.surname}`.toUpperCase();

    const account = await prisma.payoutBank.create({
      data: {
        userId: req.userId!,
        bankCode: bank.code,
        bankName: bank.name,
        accountNumber: body.accountNumber,
        accountName,
        nameMatched: true,
      },
    });

    res.status(201).json({
      data: {
        id: account.id,
        bankName: account.bankName,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        nameMatched: true,
      },
    });
  }),
);

withdrawRouter.post(
  "/",
  requireAuth,
  requireKyc("TIER_2"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        payoutBankId: z.string().min(1),
        amount: z.number().positive(),
        pin: z.string().length(4),
        idempotencyKey: z.string().min(8),
      })
      .parse(req.body);

    if (body.amount < 1000) throw new AppError(400, "Minimum withdrawal is ₦1,000", "BELOW_MINIMUM");

    await verifyTransactionPin(req.userId!, body.pin);

    const bank = await prisma.payoutBank.findFirst({
      where: { id: body.payoutBankId, userId: req.userId!, nameMatched: true },
    });
    if (!bank) throw new AppError(404, "Payout account not found", "PAYOUT_NOT_FOUND");

    const amountKobo = nairaToKobo(body.amount);
    const wallet = await getWalletBalanceKobo(req.userId!);
    if (wallet < amountKobo) throw new AppError(400, "Insufficient wallet balance", "INSUFFICIENT_FUNDS");

    const suspense = await ensureSystemAccount("SYSTEM_SUSPENSE");
    await debitWallet({
      userId: req.userId!,
      amountKobo,
      kind: "WITHDRAWAL",
      idempotencyKey: body.idempotencyKey,
      description: "Withdrawal request",
      creditAccountId: suspense.id,
    });

    const reference = makeReference("WDR");
    const row = await prisma.withdrawalRequest.create({
      data: {
        userId: req.userId!,
        payoutBankId: bank.id,
        amountKobo,
        reference,
        status: "PROCESSING",
      },
    });

    await prisma.notification.create({
      data: {
        userId: req.userId!,
        title: "Withdrawal processing",
        body: `Your withdrawal of ₦${body.amount.toLocaleString()} is being processed.`,
        href: "/withdraw/tracker",
      },
    });

    await writeAudit({
      actorUserId: req.userId,
      action: "withdrawal.create",
      entityType: "WithdrawalRequest",
      entityId: row.id,
    });

    res.status(201).json({
      data: {
        id: row.id,
        reference: row.reference,
        status: row.status,
        amount: body.amount,
      },
    });
  }),
);

withdrawRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const rows = await prisma.withdrawalRequest.findMany({
      where: { userId: req.userId! },
      include: { payoutBank: true },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        status: r.status,
        amount: koboToNaira(r.amountKobo),
        bankName: r.payoutBank.bankName,
        accountNumber: r.payoutBank.accountNumber,
        declineReason: r.declineReason,
        createdAt: r.createdAt,
      })),
    });
  }),
);

withdrawRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const row = await prisma.withdrawalRequest.findFirst({
      where: { id: String(req.params.id), userId: req.userId! },
      include: { payoutBank: true },
    });
    if (!row) throw new AppError(404, "Withdrawal not found", "NOT_FOUND");
    res.json({
      data: {
        id: row.id,
        reference: row.reference,
        status: row.status,
        amount: koboToNaira(row.amountKobo),
        bankName: row.payoutBank.bankName,
        accountNumber: row.payoutBank.accountNumber,
        accountName: row.payoutBank.accountName,
        declineReason: row.declineReason,
        createdAt: row.createdAt,
        processedAt: row.processedAt,
      },
    });
  }),
);
