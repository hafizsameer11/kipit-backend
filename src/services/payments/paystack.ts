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
