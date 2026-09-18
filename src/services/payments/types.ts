export type VirtualAccount = {
  provider: "monnify";
  accountNumber: string;
  accountName: string;
  bankName: string;
  bankCode?: string;
  reference?: string;
};

export type CardInitResult = {
  provider: "paystack";
  reference: string;
  accessCode?: string;
  authorizationUrl: string;
  publicKey?: string;
};

export type CardVerifyResult = {
  success: boolean;
  reference: string;
  amountKobo: number;
  gatewayResponse?: string;
  channel?: string;
  card?: { last4: string; brand: string; bank?: string };
};

export type TransferCreditEvent = {
  provider: "monnify";
  reference: string;
  amountKobo: number;
  accountNumber: string;
  payerAccountName?: string;
  sessionId?: string;
};

export const CARD_FEE_BPS = 150; // 1.5%

export function cardFeeKobo(amountKobo: bigint) {
  return (amountKobo * BigInt(CARD_FEE_BPS)) / 10000n;
}
