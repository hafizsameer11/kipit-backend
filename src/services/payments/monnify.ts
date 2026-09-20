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
};

function mockVirtualAccount(user: UserLike): VirtualAccount {
  const digest = createHash("sha256").update(user.id).digest("hex");
  const accountNumber = `99${digest.slice(0, 8)}`.replace(/\D/g, "").padEnd(10, "0").slice(0, 10);
  return {
    provider: "monnify",
    accountNumber,
    accountName: `KIPIT / ${user.surname.toUpperCase()} ${user.firstName.toUpperCase()}`,
    bankName: "Moniepoint MFB",
    bankCode: "50515",
    reference: `VA-${user.id.slice(-8)}`,
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
    };
  }

  if (monnifyUseMock() || !env.MONNIFY_API_KEY) {
    return mockVirtualAccount(user);
  }

  const token = await monnifyToken();
  const res = await fetch(`${monnifyBaseUrl()}/api/v2/bank-transfer/reserved-accounts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      accountReference: `kipit-${user.id}`,
      accountName: `${user.firstName} ${user.surname}`.slice(0, 100),
      currencyCode: "NGN",
      contractCode: env.MONNIFY_CONTRACT_CODE,
      customerEmail: user.email ?? `${user.id}@customers.kipit.ng`,
      customerName: `${user.firstName} ${user.surname}`,
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
    // Fall back to mock so funding still works while keys/contracts are being set up.
    console.warn("[monnify] reserved account failed, using mock VA:", json.responseMessage);
    return mockVirtualAccount(user);
  }
  return {
    provider: "monnify",
    accountNumber: account.accountNumber,
    accountName: `KIPIT / ${user.surname.toUpperCase()} ${user.firstName.toUpperCase()}`,
    bankName: account.bankName,
    bankCode: account.bankCode,
    reference: json.responseBody?.accountReference,
  };
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
