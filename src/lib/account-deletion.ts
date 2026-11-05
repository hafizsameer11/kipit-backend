/** Shared reason catalogue for customer delete-account requests. */
export const ACCOUNT_DELETION_REASON_CODES = [
  "NO_LONGER_NEED",
  "BETTER_ALTERNATIVE",
  "RETURNS_TOO_LOW",
  "SUPPORT_ISSUE",
  "PRIVACY",
  "OTHER",
] as const;

export type AccountDeletionReasonCode = (typeof ACCOUNT_DELETION_REASON_CODES)[number];

export const ACCOUNT_DELETION_REASON_LABELS: Record<AccountDeletionReasonCode, string> = {
  NO_LONGER_NEED: "I no longer need Kipit",
  BETTER_ALTERNATIVE: "I found a better alternative",
  RETURNS_TOO_LOW: "Returns or rates are too low",
  SUPPORT_ISSUE: "I had a support or service issue",
  PRIVACY: "Privacy or data concerns",
  OTHER: "Other",
};

export const ACCOUNT_DELETION_HOLD_DAYS = 30;

export function isAccountDeletionReasonCode(value: string): value is AccountDeletionReasonCode {
  return (ACCOUNT_DELETION_REASON_CODES as readonly string[]).includes(value);
}
