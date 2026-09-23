import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/errors.js";
import { env, monnifyUseMock, paystackUseMock } from "../../lib/env.js";
import { koboToNaira, makeReference, nairaToKobo } from "../../lib/crypto.js";
import { creditWalletDeposit, getWalletBalanceKobo } from "../ledger.js";
import { writeAudit } from "../audit.js";
import { ensureMonnifyVirtualAccount } from "./monnify.js";
import { initializePaystackCard, verifyPaystackTransaction } from "./paystack.js";
import { cardFeeKobo } from "./types.js";

const MIN_DEPOSIT_NAIRA = 1_000;
const MAX_CARD_NAIRA = 1_000_000;

function depositDescription(channel: string) {
  if (channel === "card") return "Card deposit";
  if (channel === "transfer") return "Bank transfer deposit";
  return "Wallet deposit";
}

export async function getOrCreateVirtualAccount(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const va = await ensureMonnifyVirtualAccount(user);
  if (user.monnifyAccountNo !== va.accountNumber || user.monnifyBankName !== va.bankName) {
    await prisma.user.update({
      where: { id: userId },
      data: { monnifyAccountNo: va.accountNumber, monnifyBankName: va.bankName },
    });
  }
  return va;
}

export async function initializeCardFunding(input: {
  userId: string;
  amountNaira: number;
  cardTokenId?: string;
  saveCard?: boolean;
}) {
  if (input.amountNaira < MIN_DEPOSIT_NAIRA) {
    throw new AppError(400, `Minimum deposit is ₦${MIN_DEPOSIT_NAIRA.toLocaleString()}`, "BELOW_MINIMUM");
  }
  if (input.amountNaira > MAX_CARD_NAIRA) {
    throw new AppError(400, `Card payments are capped at ₦${MAX_CARD_NAIRA.toLocaleString()}`, "CARD_LIMIT");
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } });
  if (user.kycTier === "TIER_0") throw new AppError(403, "Requires TIER_1", "KYC_REQUIRED");

  const amountKobo = nairaToKobo(input.amountNaira);
  const feeKobo = cardFeeKobo(amountKobo);
  const reference = makeReference("CARD");

  const init = await initializePaystackCard({
    email: user.email ?? `${user.id}@customers.kipit.ng`,
    amountKobo: Number(amountKobo + feeKobo),
    reference,
    callbackUrl: `${env.WEB_APP_URL}/wallet/processing?amount=${input.amountNaira}&method=card&ref=${reference}`,
    metadata: { userId: user.id, amountNaira: input.amountNaira, kipitChannel: "card" },
  });

  const intent = await prisma.paymentIntent.create({
    data: {
      userId: user.id,
      provider: "paystack",
      channel: "card",
      amountKobo,
      feeKobo,
      reference,
      providerRef: init.accessCode,
      authorizationUrl: init.authorizationUrl,
      metadata: {
        publicKey: init.publicKey,
        cardTokenId: input.cardTokenId,
        saveCard: input.saveCard ?? false,
        mock: paystackUseMock(),
      },
    },
  });

  return {
    intentId: intent.id,
    reference: intent.reference,
    amount: input.amountNaira,
    fee: koboToNaira(feeKobo),
    total: input.amountNaira + koboToNaira(feeKobo),
    authorizationUrl: init.authorizationUrl,
    publicKey: init.publicKey,
    accessCode: init.accessCode,
    mode: env.PAYMENTS_MODE,
    mock: paystackUseMock(),
  };
}

async function completeIntent(intentId: string, providerRef?: string) {
  const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
  if (intent.status === "SUCCESS") {
    const balanceKobo = await getWalletBalanceKobo(intent.userId);
    return {
      alreadyProcessed: true,
      reference: intent.reference,
      amount: koboToNaira(intent.amountKobo),
      wallet: { balance: koboToNaira(balanceKobo), balanceKobo: balanceKobo.toString() },
    };
  }
  if (intent.status === "FAILED") {
    throw new AppError(400, "Payment previously failed", "PAYMENT_FAILED");
  }

  const entry = await creditWalletDeposit({
    userId: intent.userId,
    amountKobo: intent.amountKobo,
    idempotencyKey: `pay-${intent.reference}`,
    description: depositDescription(intent.channel),
    metadata: {
      provider: intent.provider,
      channel: intent.channel,
      feeKobo: intent.feeKobo.toString(),
      providerRef: providerRef ?? intent.providerRef,
    },
  });

  await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: {
      status: "SUCCESS",
      completedAt: new Date(),
      providerRef: providerRef ?? intent.providerRef,
    },
  });

  await prisma.notification.create({
    data: {
      userId: intent.userId,
      title: "Wallet credited",
      body: `₦${koboToNaira(intent.amountKobo).toLocaleString()} was added to your wallet.`,
      href: "/wallet/add-money",
    },
  });

  await writeAudit({
    actorUserId: intent.userId,
    action: "wallet.deposit",
    entityType: "PaymentIntent",
    entityId: intent.id,
    after: { amount: koboToNaira(intent.amountKobo), provider: intent.provider },
  });

  const balanceKobo = await getWalletBalanceKobo(intent.userId);
  return {
    alreadyProcessed: false,
    reference: intent.reference,
    entryReference: entry.reference,
    amount: koboToNaira(intent.amountKobo),
    wallet: { balance: koboToNaira(balanceKobo), balanceKobo: balanceKobo.toString() },
  };
}

/** User tapped "I've sent the transfer" — create intent + credit in sandbox; wait for webhook in live. */
export async function confirmBankTransfer(input: {
  userId: string;
  amountNaira: number;
  forceSimulate?: boolean;
}) {
  if (input.amountNaira < MIN_DEPOSIT_NAIRA) {
    throw new AppError(400, `Minimum deposit is ₦${MIN_DEPOSIT_NAIRA.toLocaleString()}`, "BELOW_MINIMUM");
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } });
  if (user.kycTier === "TIER_0") throw new AppError(403, "Requires TIER_1", "KYC_REQUIRED");

  const amountKobo = nairaToKobo(input.amountNaira);
  const reference = makeReference("TRF");
  const intent = await prisma.paymentIntent.create({
    data: {
      userId: user.id,
      provider: "monnify",
      channel: "transfer",
      amountKobo,
      reference,
      metadata: { accountNumber: user.monnifyAccountNo, mock: monnifyUseMock() },
    },
  });

  // Mock / sandbox without provider keys: credit immediately and persist PaymentIntent SUCCESS.
  // Live with real Monnify: leave PENDING until webhook arrives.
  const simulate = input.forceSimulate ?? monnifyUseMock();
  if (simulate) {
    return completeIntent(intent.id, `mock-trf-${reference}`);
  }

  return {
    pending: true,
    reference: intent.reference,
    amount: input.amountNaira,
    message: "Waiting for Monnify to confirm the transfer (polled every minute)",
  };
}

export async function confirmCardPayment(input: { userId: string; reference: string }) {
  const intent = await prisma.paymentIntent.findFirst({
    where: { reference: input.reference, userId: input.userId, channel: "card" },
  });
  if (!intent) throw new AppError(404, "Payment not found", "PAYMENT_NOT_FOUND");

  const verified = await verifyPaystackTransaction(input.reference);
  if (!verified.success && !paystackUseMock()) {
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: "FAILED", completedAt: new Date() },
    });
    throw new AppError(402, verified.gatewayResponse ?? "Card payment failed", "CARD_DECLINED");
  }

  // Amount check when Paystack returns amount (live)
  if (verified.amountKobo > 0) {
    const expected = Number(intent.amountKobo + intent.feeKobo);
    if (Math.abs(verified.amountKobo - expected) > 1) {
      throw new AppError(400, "Amount mismatch", "AMOUNT_MISMATCH");
    }
  }

  if (verified.card) {
    const meta = (intent.metadata ?? {}) as { saveCard?: boolean };
    if (meta.saveCard) {
      await prisma.cardToken.create({
        data: {
          userId: intent.userId,
          provider: "paystack",
          token: `tok_${intent.reference}`,
          last4: verified.card.last4,
          brand: verified.card.brand,
          nickname: verified.card.bank,
        },
      });
    }
  }

  return completeIntent(intent.id, verified.reference);
}

/** Credit from Monnify webhook / admin simulate by account number. */
export async function creditFromMonnifyWebhook(input: {
  accountNumber: string;
  amountKobo: number;
  transactionReference: string;
  payerAccountName?: string;
}) {
  const user = await prisma.user.findFirst({
    where: { monnifyAccountNo: input.accountNumber },
  });
  if (!user) {
    throw new AppError(404, "Unknown virtual account", "VA_UNKNOWN");
  }

  const existing = await prisma.paymentIntent.findUnique({
    where: { reference: input.transactionReference },
  });
  if (existing?.status === "SUCCESS") {
    return { alreadyProcessed: true, userId: user.id };
  }

  const intent =
    existing ??
    (await prisma.paymentIntent.create({
      data: {
        userId: user.id,
        provider: "monnify",
        channel: "transfer",
        amountKobo: BigInt(input.amountKobo),
        reference: input.transactionReference,
        providerRef: input.transactionReference,
        metadata: { payerAccountName: input.payerAccountName },
      },
    }));

  return completeIntent(intent.id, input.transactionReference);
}

export async function listSavedCards(userId: string) {
  const cards = await prisma.cardToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return cards.map((c) => ({
    id: c.id,
    brand: c.brand ?? "Card",
    last4: c.last4,
    bank: c.nickname ?? "Bank",
    provider: c.provider,
  }));
}

export async function deleteSavedCard(userId: string, cardId: string) {
  const existing = await prisma.cardToken.findFirst({
    where: { id: cardId, userId },
  });
  if (!existing) {
    throw new AppError(404, "Card not found", "NOT_FOUND");
  }
  await prisma.cardToken.delete({ where: { id: cardId } });
  return { ok: true as const };
}
