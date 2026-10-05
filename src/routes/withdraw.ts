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
import { fuzzyScore } from "../services/kyc.js";
import { listPaystackBanks, resolvePaystackAccount } from "../services/payments/paystack.js";
import { paystackUseMock } from "../lib/env.js";
import { rejectIfMaintenance } from "../middleware/maintenance.js";

export const withdrawRouter = Router();
withdrawRouter.use(rejectIfMaintenance);

const NAME_MATCH_MIN = 0.5;

async function resolveAndMatchAccount(input: {
  userId: string;
  bankCode: string;
  accountNumber: string;
}) {
  const banks = await listPaystackBanks();
  const bank = banks.find((b) => b.code === input.bankCode);
  if (!bank) throw new AppError(400, "Unknown bank", "BANK_UNKNOWN");

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
    include: { kycProfile: true },
  });
  const profileName = [user.firstName, user.middleName, user.surname]
    .filter(Boolean)
    .join(" ")
    .trim();
  const bvnName = user.kycProfile?.bvnName?.trim() || "";
  const ninName = user.kycProfile?.ninName?.trim() || "";

  const resolved = await resolvePaystackAccount({
    accountNumber: input.accountNumber,
    bankCode: input.bankCode,
    mockAccountName: paystackUseMock() ? profileName : undefined,
  });

  const candidates = [profileName, bvnName, ninName].filter(Boolean);
  const bestScore = Math.max(0, ...candidates.map((name) => fuzzyScore(name, resolved.accountName)));
  const nameMatched = bestScore >= NAME_MATCH_MIN;

  if (!nameMatched) {
    throw new AppError(
      400,
      `Account name does not match your Kipit profile. This account shows as “${resolved.accountName}”. Use an account in your legal name.`,
      "ACCOUNT_NAME_MISMATCH",
    );
  }

  return {
    bank,
    resolved,
    bestScore,
    nameMatched: true as const,
  };
}

withdrawRouter.get(
  "/banks",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const banks = await listPaystackBanks();
    res.json({ data: banks });
  }),
);

/** Resolve + name-match only — does NOT create a PayoutBank row (app-safe additive route). */
withdrawRouter.post(
  "/accounts/resolve",
  requireAuth,
  requireKyc("TIER_2"),
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        bankCode: z.string().min(2),
        accountNumber: z.string().min(10).max(10),
      })
      .parse(req.body);

    const { bank, resolved, bestScore, nameMatched } = await resolveAndMatchAccount({
      userId: req.userId!,
      bankCode: body.bankCode,
      accountNumber: body.accountNumber,
    });

    res.json({
      data: {
        bankCode: bank.code,
        bankName: bank.name,
        accountNumber: resolved.accountNumber,
        accountName: resolved.accountName.toUpperCase(),
        nameMatched,
        matchScore: bestScore,
      },
    });
  }),
);

withdrawRouter.get(
  "/accounts",
  requireAuth,
  requireKyc("TIER_2"),
  asyncHandler(async (req: AuthRequest, res) => {
    const accounts = await prisma.payoutBank.findMany({
      where: { userId: req.userId!, removedAt: null },
      orderBy: { createdAt: "asc" },
    });
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

withdrawRouter.delete(
  "/accounts/:id",
  requireAuth,
  requireKyc("TIER_2"),
  asyncHandler(async (req: AuthRequest, res) => {
    const id = String(req.params.id || "");
    const account = await prisma.payoutBank.findFirst({
      where: { id, userId: req.userId!, removedAt: null },
    });
    if (!account) throw new AppError(404, "Payout account not found", "NOT_FOUND");

    const pending = await prisma.withdrawalRequest.count({
      where: { payoutBankId: account.id, status: "PROCESSING" },
    });
    // Only block if a live withdrawal still needs this destination.
    if (pending > 0) {
      throw new AppError(
        400,
        "This account has a withdrawal in progress. Wait until it settles, then try again.",
        "PAYOUT_IN_USE",
      );
    }

    // Soft-delete: hard delete fails when past WithdrawalRequest rows still reference the bank.
    await prisma.payoutBank.update({
      where: { id: account.id },
      data: { removedAt: new Date() },
    });
    await writeAudit({
      actorUserId: req.userId,
      action: "payout_bank.delete",
      entityType: "PayoutBank",
      entityId: account.id,
      after: { bankCode: account.bankCode, accountNumber: account.accountNumber, soft: true },
    });
    res.json({ data: { ok: true } });
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

    const { bank, resolved, bestScore } = await resolveAndMatchAccount({
      userId: req.userId!,
      bankCode: body.bankCode,
      accountNumber: body.accountNumber,
    });

    const existing = await prisma.payoutBank.findFirst({
      where: {
        userId: req.userId!,
        bankCode: bank.code,
        accountNumber: resolved.accountNumber,
      },
    });
    if (existing) {
      const restored =
        existing.removedAt != null
          ? await prisma.payoutBank.update({
              where: { id: existing.id },
              data: {
                removedAt: null,
                accountName: resolved.accountName.toUpperCase(),
                bankName: bank.name,
                nameMatched: true,
              },
            })
          : existing;
      res.status(200).json({
        data: {
          id: restored.id,
          bankName: restored.bankName,
          bankCode: restored.bankCode,
          accountNumber: restored.accountNumber,
          accountName: restored.accountName,
          nameMatched: restored.nameMatched,
        },
      });
      return;
    }

    const account = await prisma.payoutBank.create({
      data: {
        userId: req.userId!,
        bankCode: bank.code,
        bankName: bank.name,
        accountNumber: resolved.accountNumber,
        accountName: resolved.accountName.toUpperCase(),
        nameMatched: true,
      },
    });

    await writeAudit({
      actorUserId: req.userId,
      action: "payout_bank.create",
      entityType: "PayoutBank",
      entityId: account.id,
      after: {
        bankCode: bank.code,
        accountNumber: resolved.accountNumber,
        score: bestScore,
        provider: paystackUseMock() ? "paystack_mock" : "paystack",
      },
    });

    res.status(201).json({
      data: {
        id: account.id,
        bankName: account.bankName,
        bankCode: account.bankCode,
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

    const { getOpsLimits } = await import("../services/system-settings.js");
    const ops = await getOpsLimits();
    if (body.amount > ops.singlePayoutMax) {
      throw new AppError(
        400,
        `Single payout maximum is ₦${ops.singlePayoutMax.toLocaleString("en-NG")}`,
        "ABOVE_SINGLE_LIMIT",
      );
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todays = await prisma.withdrawalRequest.findMany({
      where: {
        userId: req.userId!,
        createdAt: { gte: startOfDay },
        status: { not: "DECLINED" },
      },
      select: { amountKobo: true },
    });
    const todaysNaira = todays.reduce((sum, w) => sum + koboToNaira(w.amountKobo), 0);
    const dailyCap = ops.tier2DailyWithdrawal;
    if (todaysNaira + body.amount > dailyCap) {
      throw new AppError(
        400,
        `Daily withdrawal limit is ₦${dailyCap.toLocaleString("en-NG")}. You've used ₦${todaysNaira.toLocaleString("en-NG")} today.`,
        "ABOVE_DAILY_LIMIT",
      );
    }

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
    const { withdrawalSettleOn } = await import("../services/system-settings.js");
    const settlement = await withdrawalSettleOn();
    const row = await prisma.withdrawalRequest.create({
      data: {
        userId: req.userId!,
        payoutBankId: bank.id,
        amountKobo,
        reference,
        status: "PROCESSING",
      },
    });

    const { notifyCustomer, sendOpsWithdrawalAlert } = await import("../services/notify.js");
    const customer = await prisma.user.findUnique({ where: { id: req.userId! } });
    const settleNote = settlement.sameDay
      ? `Same-day batch (cut-off ${settlement.cutoff} Lagos)`
      : `After ${settlement.cutoff} Lagos cut-off — settles ${settlement.settleOn}`;
    await notifyCustomer({
      userId: req.userId!,
      title: "Withdrawal processing",
      body: `Your withdrawal of ₦${body.amount.toLocaleString()} is being processed. ${settleNote}.`,
      href: "/withdraw/tracker",
      emailKind: "withdrawal",
      amountNaira: body.amount,
      emailDetail: `Reference ${reference}. ${settleNote}`,
    }).catch(() => undefined);
    if (customer) {
      await sendOpsWithdrawalAlert({
        customerName: `${customer.firstName} ${customer.surname}`.trim(),
        customerEmail: customer.email,
        amountNaira: body.amount,
        reference,
        withdrawalId: row.id,
      }).catch((err) => console.warn("[ops-withdraw-alert]", err));
    }

    await writeAudit({
      actorUserId: req.userId,
      action: "withdrawal.create",
      entityType: "WithdrawalRequest",
      entityId: row.id,
      after: settlement,
    });

    res.status(201).json({
      data: {
        id: row.id,
        reference: row.reference,
        status: row.status,
        amount: body.amount,
        settleOn: settlement.settleOn,
        sameDaySettlement: settlement.sameDay,
        payoutCutoff: settlement.cutoff,
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
    const { getOpsCutoffs, settleOnFromCutoff } = await import("../services/system-settings.js");
    const { payoutBatch } = await getOpsCutoffs();
    res.json({
      data: rows.map((r) => {
        const settlement = settleOnFromCutoff(r.createdAt, payoutBatch);
        return {
          id: r.id,
          reference: r.reference,
          status: r.status,
          amount: koboToNaira(r.amountKobo),
          bankName: r.payoutBank.bankName,
          accountNumber: r.payoutBank.accountNumber,
          declineReason: r.declineReason,
          createdAt: r.createdAt,
          settleOn: settlement.settleOn,
          sameDaySettlement: settlement.sameDay,
        };
      }),
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
    const { withdrawalSettleOn } = await import("../services/system-settings.js");
    const settlement = await withdrawalSettleOn(row.createdAt);
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
        settleOn: settlement.settleOn,
        sameDaySettlement: settlement.sameDay,
        payoutCutoff: settlement.cutoff,
      },
    });
  }),
);
