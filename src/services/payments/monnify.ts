import { createHash } from "node:crypto";
import { env, monnifyBaseUrl, monnifyUseMock } from "../../lib/env.js";
import { AppError } from "../../lib/errors.js";
import type { VirtualAccount } from "./types.js";

type UserLike = {
  id: string;
  email: string | null;
  firstName: string;
  surname: string;
  monnifyAccountNo: string | null;
  monnifyBankName: string | null;
  /** Required by Monnify live reserved accounts */
  bvn?: string | null;
  nin?: string | null;
};

/** Stable Monnify reserved-account reference for a Kipit user. */
export function monnifyAccountReference(userId: string) {
  return `kipit-${userId}`;
}

function mockVirtualAccount(user: UserLike): VirtualAccount {
  const digest = createHash("sha256").update(user.id).digest("hex");
  const accountNumber = `99${digest.slice(0, 8)}`.replace(/\D/g, "").padEnd(10, "0").slice(0, 10);
  return {
    provider: "monnify",
    accountNumber,
    accountName: `KIPIT / ${user.surname.toUpperCase()} ${user.firstName.toUpperCase()}`,
    bankName: "Moniepoint MFB",
    bankCode: "50515",
    reference: monnifyAccountReference(user.id),
  };
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function monnifyToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;
  const auth = Buffer.from(`${env.MONNIFY_API_KEY}:${env.MONNIFY_SECRET_KEY}`).toString("base64");
  const res = await fetch(`${monnifyBaseUrl()}/api/v1/auth/login`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
  });
  const json = (await res.json()) as {
    requestSuccessful?: boolean;
    responseBody?: { accessToken?: string; expiresIn?: number };
    responseMessage?: string;
  };
  if (!res.ok || !json.responseBody?.accessToken) {
    throw new AppError(502, json.responseMessage ?? "Monnify auth failed", "MONNIFY_AUTH");
  }
  cachedToken = {
    value: json.responseBody.accessToken,
    expiresAt: Date.now() + (json.responseBody.expiresIn ?? 3500) * 1000,
  };
  return cachedToken.value;
}

export async function ensureMonnifyVirtualAccount(user: UserLike): Promise<VirtualAccount> {
  if (user.monnifyAccountNo && user.monnifyBankName) {
    return {
      provider: "monnify",
      accountNumber: user.monnifyAccountNo,
      accountName: `KIPIT / ${user.surname.toUpperCase()} ${user.firstName.toUpperCase()}`,
      bankName: user.monnifyBankName,
      reference: monnifyAccountReference(user.id),
    };
  }

  if (monnifyUseMock() || !env.MONNIFY_API_KEY) {
    return mockVirtualAccount(user);
  }

  const bvn = user.bvn?.trim() || undefined;
  const nin = user.nin?.trim() || undefined;
  if (env.PAYMENTS_MODE === "live" && !bvn && !nin) {
    throw new AppError(
      400,
      "Complete BVN or NIN verification before creating a live virtual account",
      "KYC_IDENTITY_REQUIRED",
    );
  }

  const token = await monnifyToken();
  const accountReference = monnifyAccountReference(user.id);
  const res = await fetch(`${monnifyBaseUrl()}/api/v2/bank-transfer/reserved-accounts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      accountReference,
      accountName: `${user.firstName} ${user.surname}`.slice(0, 100),
      currencyCode: "NGN",
      contractCode: env.MONNIFY_CONTRACT_CODE,
      customerEmail: user.email ?? `${user.id}@customers.kipit.ng`,
      customerName: `${user.firstName} ${user.surname}`,
      ...(bvn ? { bvn } : {}),
      ...(nin ? { nin } : {}),
      getAllAvailableBanks: false,
      preferredBanks: ["50515", "035"],
    }),
  });
  const json = (await res.json()) as {
    requestSuccessful?: boolean;
    responseBody?: {
      accounts?: { accountNumber: string; bankName: string; bankCode?: string }[];
      accountReference?: string;
    };
    responseMessage?: string;
  };
  const account = json.responseBody?.accounts?.[0];
  if (!res.ok || !account) {
    // Never hand out fake VAs in live — banks will reject them as invalid.
    if (env.PAYMENTS_MODE === "live" || !monnifyUseMock()) {
      console.error("[monnify] reserved account failed:", json.responseMessage);
      throw new AppError(
        502,
        json.responseMessage ?? "Could not create Monnify virtual account",
        "MONNIFY_VA_FAILED",
      );
    }
    console.warn("[monnify] reserved account failed, using mock VA:", json.responseMessage);
    return mockVirtualAccount(user);
  }
  return {
    provider: "monnify",
    accountNumber: account.accountNumber,
    accountName: `KIPIT / ${user.surname.toUpperCase()} ${user.firstName.toUpperCase()}`,
    bankName: account.bankName,
    bankCode: account.bankCode,
    reference: json.responseBody?.accountReference ?? accountReference,
  };
}

export type MonnifyReservedTxn = {
  transactionReference: string;
  paymentReference?: string | null;
  amountPaidNaira: number;
  paymentStatus: string;
  completedOn?: string | null;
  customerName?: string | null;
};

/**
 * Recent transactions on a reserved VA.
 * GET /api/v1/bank-transfer/reserved-accounts/transactions
 */
export async function listReservedAccountTransactions(input: {
  accountReference: string;
  page?: number;
  size?: number;
}): Promise<MonnifyReservedTxn[]> {
  if (monnifyUseMock() || !env.MONNIFY_API_KEY) return [];

  const token = await monnifyToken();
  const qs = new URLSearchParams({
    accountReference: input.accountReference,
    page: String(input.page ?? 0),
    size: String(input.size ?? 20),
  });
  const res = await fetch(
    `${monnifyBaseUrl()}/api/v1/bank-transfer/reserved-accounts/transactions?${qs}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = (await res.json()) as {
    requestSuccessful?: boolean;
    responseMessage?: string;
    responseBody?: {
      content?: {
        transactionReference?: string;
        paymentReference?: string;
        amountPaid?: number;
        amount?: number;
        paymentStatus?: string;
        completedOn?: string;
        customerName?: string;
      }[];
    };
  };
  if (!res.ok) {
    throw new AppError(502, json.responseMessage ?? "Monnify transactions failed", "MONNIFY_TXNS");
  }

  return (json.responseBody?.content ?? [])
    .filter((row) => row.transactionReference)
    .map((row) => ({
      transactionReference: String(row.transactionReference),
      paymentReference: row.paymentReference ?? null,
      amountPaidNaira: Number(row.amountPaid ?? row.amount ?? 0),
      paymentStatus: String(row.paymentStatus ?? "").toUpperCase(),
      completedOn: row.completedOn ?? null,
      customerName: row.customerName ?? null,
    }));
}

export function verifyMonnifyWebhookSignature(
  payload: string,
  signatureHeader: string | undefined,
): boolean {
  if (monnifyUseMock() || !env.MONNIFY_SECRET_KEY) return true;
  if (!signatureHeader) return false;
  const computed = createHash("sha512")
    .update(env.MONNIFY_SECRET_KEY + payload)
    .digest("hex");
  return computed.toLowerCase() === signatureHeader.toLowerCase();
}
