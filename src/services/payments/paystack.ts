import { createHmac } from "node:crypto";
import { env, paystackUseMock, paystackBaseUrl } from "../../lib/env.js";
import { AppError } from "../../lib/errors.js";
import type { CardInitResult, CardVerifyResult } from "./types.js";

async function paystackFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${paystackBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json()) as T & { status?: boolean; message?: string };
  if (!res.ok || (json as { status?: boolean }).status === false) {
    throw new AppError(
      502,
      (json as { message?: string }).message ?? "Paystack request failed",
      "PAYSTACK_ERROR",
    );
  }
  return json;
}

const FALLBACK_NGN_BANKS = [
  { code: "058", name: "Guaranty Trust Bank" },
  { code: "033", name: "United Bank For Africa" },
  { code: "011", name: "First Bank of Nigeria" },
  { code: "057", name: "Zenith Bank" },
  { code: "032", name: "Union Bank of Nigeria" },
  { code: "214", name: "First City Monument Bank" },
  { code: "044", name: "Access Bank" },
  { code: "070", name: "Fidelity Bank" },
  { code: "076", name: "Polaris Bank" },
  { code: "082", name: "Keystone Bank" },
  { code: "221", name: "Stanbic IBTC Bank" },
  { code: "232", name: "Sterling Bank" },
  { code: "035", name: "Wema Bank" },
];

export type PaystackBank = { code: string; name: string };

/** Nigerian NUBAN bank list from Paystack (cached briefly in-process). */
let banksCache: { at: number; banks: PaystackBank[] } | null = null;
const BANKS_TTL_MS = 6 * 60 * 60 * 1000;

export async function listPaystackBanks(): Promise<PaystackBank[]> {
  if (banksCache && Date.now() - banksCache.at < BANKS_TTL_MS) {
    return banksCache.banks;
  }

  if (paystackUseMock()) {
    banksCache = { at: Date.now(), banks: FALLBACK_NGN_BANKS };
    return FALLBACK_NGN_BANKS;
  }

  try {
    const json = await paystackFetch<{
      data: { name: string; code: string; active?: boolean; currency?: string; type?: string }[];
    }>("/bank?country=nigeria&currency=NGN&type=nuban");

    const banks = (json.data ?? [])
      .filter((b) => b.code && b.name && b.active !== false)
      .map((b) => ({ code: String(b.code), name: String(b.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!banks.length) {
      banksCache = { at: Date.now(), banks: FALLBACK_NGN_BANKS };
      return FALLBACK_NGN_BANKS;
    }

    banksCache = { at: Date.now(), banks };
    return banks;
  } catch {
    // Keep withdrawals usable if Paystack bank list is briefly down.
    banksCache = { at: Date.now(), banks: FALLBACK_NGN_BANKS };
    return FALLBACK_NGN_BANKS;
  }
}

export type ResolvedPaystackAccount = {
  accountNumber: string;
  accountName: string;
  bankId?: number | null;
};

/**
 * Name enquiry via Paystack bank resolve.
 * Docs: GET /bank/resolve?account_number=&bank_code=
 */
export async function resolvePaystackAccount(input: {
  accountNumber: string;
  bankCode: string;
  /** Used only when Paystack is mocked — returned as the resolved account name. */
  mockAccountName?: string;
}): Promise<ResolvedPaystackAccount> {
  const accountNumber = input.accountNumber.replace(/\D/g, "");
  if (!/^\d{10}$/.test(accountNumber)) {
    throw new AppError(400, "Account number must be 10 digits", "ACCOUNT_INVALID");
  }
  if (!input.bankCode.trim()) {
    throw new AppError(400, "Bank code is required", "BANK_REQUIRED");
  }

  if (paystackUseMock()) {
    return {
      accountNumber,
      accountName: (input.mockAccountName?.trim() || `MOCK ACCOUNT ${accountNumber.slice(-4)}`).toUpperCase(),
      bankId: null,
    };
  }

  const qs = new URLSearchParams({
    account_number: accountNumber,
    bank_code: input.bankCode.trim(),
  });

  const json = await paystackFetch<{
    data: { account_number: string; account_name: string; bank_id?: number };
  }>(`/bank/resolve?${qs.toString()}`);

  return {
    accountNumber: json.data.account_number,
    accountName: json.data.account_name,
    bankId: json.data.bank_id ?? null,
  };
}

export async function initializePaystackCard(input: {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}): Promise<CardInitResult> {
  if (paystackUseMock()) {
    return {
      provider: "paystack",
      reference: input.reference,
      accessCode: `mock_${input.reference}`,
      authorizationUrl: `${env.WEB_APP_URL}/wallet/processing?amount=${Math.round(input.amountKobo / 100)}&method=card&ref=${encodeURIComponent(input.reference)}`,
      publicKey: env.PAYSTACK_PUBLIC_KEY || "pk_test_mock",
    };
  }

  const json = await paystackFetch<{
    data: { authorization_url: string; access_code: string; reference: string };
  }>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      amount: input.amountKobo,
      reference: input.reference,
      callback_url: input.callbackUrl,
      currency: "NGN",
      channels: ["card"],
      metadata: input.metadata,
    }),
  });

  return {
    provider: "paystack",
    reference: json.data.reference,
    accessCode: json.data.access_code,
    authorizationUrl: json.data.authorization_url,
    publicKey: env.PAYSTACK_PUBLIC_KEY || undefined,
  };
}

export async function verifyPaystackTransaction(reference: string): Promise<CardVerifyResult> {
  if (paystackUseMock()) {
    return {
      success: true,
      reference,
      amountKobo: 0, // caller already knows amount from PaymentIntent
      gatewayResponse: "Successful (sandbox mock)",
      channel: "card",
      card: { last4: "4081", brand: "visa", bank: "TEST BANK" },
    };
  }

  const json = await paystackFetch<{
    data: {
      status: string;
      amount: number;
      reference: string;
      gateway_response?: string;
      channel?: string;
      authorization?: { last4?: string; brand?: string; bank?: string };
    };
  }>(`/transaction/verify/${encodeURIComponent(reference)}`);

  const ok = json.data.status === "success";
  return {
    success: ok,
    reference: json.data.reference,
    amountKobo: json.data.amount,
    gatewayResponse: json.data.gateway_response,
    channel: json.data.channel,
    card: json.data.authorization
      ? {
          last4: json.data.authorization.last4 ?? "0000",
          brand: json.data.authorization.brand ?? "card",
          bank: json.data.authorization.bank,
        }
      : undefined,
  };
}

export function verifyPaystackWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (paystackUseMock()) return true;
  if (!signatureHeader) return false;
  const hash = createHmac("sha512", env.PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  return hash === signatureHeader;
}

/** Sandbox payout — used when admin marks withdrawal successful. */
export async function initiatePaystackTransfer(input: {
  amountKobo: number;
  reference: string;
  reason: string;
  recipientCode?: string;
  accountNumber: string;
  bankCode: string;
  accountName: string;
}): Promise<{ transferCode: string; status: string }> {
  if (paystackUseMock()) {
    return { transferCode: `TRF_MOCK_${input.reference}`, status: "success" };
  }

  // Create transfer recipient then initiate transfer
  const recipient = await paystackFetch<{ data: { recipient_code: string } }>("/transferrecipient", {
    method: "POST",
    body: JSON.stringify({
      type: "nuban",
      name: input.accountName,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      currency: "NGN",
    }),
  });

  const transfer = await paystackFetch<{ data: { transfer_code: string; status: string } }>(
    "/transfer",
    {
      method: "POST",
      body: JSON.stringify({
        source: "balance",
        amount: input.amountKobo,
        reference: input.reference,
        reason: input.reason,
        recipient: input.recipientCode ?? recipient.data.recipient_code,
      }),
    },
  );

  return { transferCode: transfer.data.transfer_code, status: transfer.data.status };
}
