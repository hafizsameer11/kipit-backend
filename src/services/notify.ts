import { prisma } from "../lib/prisma.js";
import { brandWrap, sendEmail } from "./email.js";
import { sendPushToUser, type PushKind } from "./push.js";

/** B16 — Lotanna welcome (exact wording from feedback PDF pp.25–26). */
export async function sendWelcomeEmail(input: {
  to: string;
  firstName: string;
  tempPassword?: string;
  accountType?: "PERSONAL" | "BUSINESS";
}) {
  const name = input.firstName.trim() || "there";
  const tempBlock = input.tempPassword
    ? `<p style="margin:16px 0;padding:12px 14px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0"><strong>Temporary password:</strong> <code>${input.tempPassword}</code><br/><span style="color:#64748b;font-size:13px">Please sign in and change it right away.</span></p>`
    : "";
  const subject = "Welcome to Kipit";
  const text = [
    `Welcome to Kipit, ${name}.`,
    "",
    "Thank you for choosing to grow your money with us.",
    "",
    "I started Kipit because I believe every Nigerian deserves a safe, simple and rewarding place to build wealth, without high minimums, hidden charges or confusing terms.",
    "",
    "Your investments are managed by Kipit Asset Management, a fund manager licensed by the Securities and Exchange Commission (SEC), and your funds are held with Rand Merchant Bank, our custodian.",
    "",
    "You can start with as little as ₦1,000, see your rate before you invest, and watch your interest grow every day.",
    "",
    "Our promise to you is simple. We will keep our word, we will be open with you, and we will treat your money with the same care we give our own.",
    "",
    "If you ever need help, our team is one message away on WhatsApp at +234 707 198 5171 or at support@mykipit.com.",
    "",
    "Welcome to the Kipit family. Let's build wealth, deliberately.",
    input.tempPassword ? "" : null,
    input.tempPassword ? `Temporary password: ${input.tempPassword}` : null,
    "",
    "Warm regards,",
    "Lotanna",
  ]
    .filter((line) => line != null)
    .join("\n");

  const html = brandWrap(
    "Welcome to Kipit",
    `
      <p style="margin:0 0 12px">Welcome to Kipit, <strong>${escapeHtml(name)}</strong>.</p>
      <p style="margin:0 0 12px">Thank you for choosing to grow your money with us.</p>
      <p style="margin:0 0 12px">I started Kipit because I believe every Nigerian deserves a safe, simple and rewarding place to build wealth, without high minimums, hidden charges or confusing terms.</p>
      <p style="margin:0 0 12px">Your investments are managed by <strong>Kipit Asset Management</strong>, a fund manager licensed by the Securities and Exchange Commission (SEC), and your funds are held with <strong>Rand Merchant Bank</strong>, our custodian.</p>
      <p style="margin:0 0 12px">You can start with as little as <strong>₦1,000</strong>, see your rate before you invest, and watch your interest grow every day.</p>
      <p style="margin:0 0 12px">Our promise to you is simple. We will keep our word, we will be open with you, and we will treat your money with the same care we give our own.</p>
      <p style="margin:0 0 12px">If you ever need help, our team is one message away on WhatsApp at <a href="https://wa.me/2347071985171">+234 707 198 5171</a> or at <a href="mailto:support@mykipit.com">support@mykipit.com</a>.</p>
      <p style="margin:0 0 12px">Welcome to the Kipit family. Let's build wealth, deliberately.</p>
      ${tempBlock}
      <p style="margin:16px 0 0">Warm regards,<br/><strong>Lotanna</strong></p>
    `,
  );

  return sendEmail({ to: input.to, subject, text, html });
}

/** B24 — profile update email (exact wording from feedback PDF pp.32–33). */
export async function sendProfileUpdatedEmail(input: {
  to: string;
  firstName: string;
  changeSummary: string;
  /** ISO or display string; defaults to now (Lagos-friendly en-NG). */
  activityAt?: string | Date;
}) {
  const name = input.firstName.trim() || "there";
  const { date, time } = formatActivityParts(input.activityAt ?? new Date());
  const subject = "Your Kipit profile was updated";
  const text = [
    `Dear ${name},`,
    "",
    `Your Kipit profile was updated on ${date} at ${time}.`,
    "",
    `Change made: ${input.changeSummary}.`,
    "",
    "If you made this change, no further action is needed. If you did not initiate this action, kindly reach out to our support team immediately on WhatsApp at +234 707 198 5171 or at support@mykipit.com.",
    "",
    "The Kipit Team",
  ].join("\n");
  const html = brandWrap(
    "Your Kipit profile was updated",
    `
      <p style="margin:0 0 12px">Dear ${escapeHtml(name)},</p>
      <p style="margin:0 0 12px">Your Kipit profile was updated on <strong>${escapeHtml(date)}</strong> at <strong>${escapeHtml(time)}</strong>.</p>
      <p style="margin:0 0 16px"><strong>Change made:</strong> ${escapeHtml(input.changeSummary)}.</p>
      <p style="margin:0 0 12px">If you made this change, no further action is needed. If you did not initiate this action, kindly reach out to our support team immediately on WhatsApp at <a href="https://wa.me/2347071985171">+234 707 198 5171</a> or at <a href="mailto:support@mykipit.com">support@mykipit.com</a>.</p>
      <p style="margin:16px 0 0">The Kipit Team</p>
    `,
  );
  return sendEmail({ to: input.to, subject, text, html });
}

function formatActivityParts(value: string | Date) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    const raw = String(value);
    return { date: raw, time: "" };
  }
  const date = d.toLocaleDateString("en-NG", {
    timeZone: "Africa/Lagos",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-NG", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
  });
  return { date, time };
}

function formatMaturityDate(value?: string | Date) {
  const d = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return formatActivityParts(new Date()).date;
  return d.toLocaleDateString("en-NG", {
    timeZone: "Africa/Lagos",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nairaLine(n: number) {
  return `₦${Math.round(n).toLocaleString("en-NG")}`;
}

/** B15 — maturity email (exact wording from feedback PDF pp.24–25). */
export async function sendMaturityEmail(input: {
  to: string;
  firstName: string;
  planLabel: string;
  tenorDays: number;
  principalNaira: number;
  grossInterestNaira: number;
  whtNaira: number;
  netInterestNaira: number;
  totalPaidNaira: number;
  outcome: "wallet" | "call" | "rollover";
  balanceNaira?: number;
  rolloverRatePct?: string;
  rolloverMaturityDate?: string;
  /** Calendar day the plan matured (defaults to today). */
  maturedOn?: string | Date;
}) {
  const name = input.firstName.trim() || "there";
  const maturedOn = formatMaturityDate(input.maturedOn);
  const total = nairaLine(input.totalPaidNaira);
  const subject = "Hooray! Your Kipit investment has matured";

  const instructionBit =
    input.outcome === "rollover"
      ? `rolled over into a new ${input.tenorDays}-day plan at ${input.rolloverRatePct ?? "—"}% p.a., maturing on ${input.rolloverMaturityDate ?? "—"}`
      : input.outcome === "call"
        ? "moved to your Call Account"
        : "paid into your Kipit wallet";

  const balanceLine =
    input.outcome === "rollover"
      ? null
      : input.outcome === "call"
        ? `Your Call Account balance is now ${nairaLine(input.balanceNaira ?? 0)}.`
        : `Your wallet balance is now ${nairaLine(input.balanceNaira ?? 0)}.`;

  const instructionLine = `In line with your maturity instruction, ${total} has been ${instructionBit}.`;

  const text = [
    `Dear ${name},`,
    "",
    `Congratulations! Your ${input.tenorDays}-day plan reached maturity today, ${maturedOn}.`,
    "",
    `Principal: ${nairaLine(input.principalNaira)}`,
    `Gross interest: ${nairaLine(input.grossInterestNaira)}`,
    `Less withholding tax (10%): ${nairaLine(input.whtNaira)}`,
    `Net interest: ${nairaLine(input.netInterestNaira)}`,
    `Total paid (principal + net interest): ${total}`,
    "",
    instructionLine,
    ...(balanceLine ? [balanceLine, ""] : [""]),
    "Thank you for trusting us with your money. If you have any questions, reach us on WhatsApp at +234 707 198 5171 or at support@mykipit.com.",
    "",
    "Warm regards,",
    "The Kipit Team",
  ].join("\n");

  const html = brandWrap(
    "Hooray! Your Kipit investment has matured",
    `
      <p style="margin:0 0 12px">Dear ${escapeHtml(name)},</p>
      <p style="margin:0 0 16px">Congratulations! Your ${input.tenorDays}-day plan reached maturity today, <strong>${escapeHtml(maturedOn)}</strong>.</p>
      <p style="margin:0 0 8px;color:#64748b;font-size:13px">Plan: ${escapeHtml(input.planLabel)}</p>
      <table style="width:100%;border-collapse:collapse;margin:12px 0 16px;font-size:14px">
        <tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Principal</td><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700">${nairaLine(input.principalNaira)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Gross interest</td><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700">${nairaLine(input.grossInterestNaira)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Less withholding tax (10%)</td><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700">${nairaLine(input.whtNaira)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#64748b">Net interest</td><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700">${nairaLine(input.netInterestNaira)}</td></tr>
        <tr><td style="padding:10px 0;color:#0b1d3a;font-weight:800">Total paid (principal + net interest)</td><td style="padding:10px 0;text-align:right;font-weight:800;color:#b98113">${total}</td></tr>
      </table>
      <p style="margin:0 0 12px">${escapeHtml(instructionLine)}</p>
      ${balanceLine ? `<p style="margin:0 0 16px">${escapeHtml(balanceLine)}</p>` : ""}
      <p style="margin:0 0 12px">Thank you for trusting us with your money. If you have any questions, reach us on WhatsApp at <a href="https://wa.me/2347071985171">+234 707 198 5171</a> or at <a href="mailto:support@mykipit.com">support@mykipit.com</a>.</p>
      <p style="margin:16px 0 0">Warm regards,<br/><strong>The Kipit Team</strong></p>
    `,
  );
  return sendEmail({ to: input.to, subject, text, html });
}

/** Email a newly generated temporary password after an admin resets a customer account. */
export async function sendCustomerPasswordResetEmail(input: {
  to: string;
  firstName: string;
  tempPassword: string;
}) {
  const name = input.firstName.trim() || "there";
  const subject = "Your Kipit password was reset";
  const text = [
    `Hi ${name},`,
    "",
    "An administrator reset the password on your Kipit account.",
    "",
    `Temporary password: ${input.tempPassword}`,
    "",
    "Sign in with this password, then change it in Settings → Security.",
    "",
    "If you did not expect this, contact Kipit support right away.",
    "",
    "— Kipit",
  ].join("\n");
  const html = brandWrap(
    "Password reset",
    `
      <p style="margin:0 0 12px">Hi ${name},</p>
      <p style="margin:0 0 12px">An administrator reset the password on your Kipit account.</p>
      <p style="margin:16px 0;padding:12px 14px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0">
        <strong>Temporary password:</strong> <code>${input.tempPassword}</code><br/>
        <span style="color:#64748b;font-size:13px">Sign in, then change it in Settings → Security.</span>
      </p>
      <p style="margin:0 0 12px">If you did not expect this, contact Kipit support right away.</p>
    `,
  );
  return sendEmail({ to: input.to, subject, text, html });
}

export async function sendAdminInviteEmail(input: {
  to: string;
  name: string;
  tempPassword: string;
  role: string;
}) {
  const name = input.name.trim() || "there";
  const subject = "You're invited to the Kipit admin console";
  const text = [
    `Hi ${name},`,
    "",
    "You've been invited to the Kipit operations console.",
    `Role: ${input.role}`,
    "",
    `Temporary password: ${input.tempPassword}`,
    "",
    "Sign in and change your password at first login.",
    "",
    "— Kipit Operations",
  ].join("\n");
  const html = brandWrap(
    "Kipit console invitation",
    `
      <p style="margin:0 0 12px">Hi ${name},</p>
      <p style="margin:0 0 12px">You've been invited to the <strong>Kipit admin console</strong>.</p>
      <p style="margin:0 0 12px">Role: <strong>${input.role}</strong></p>
      <p style="margin:16px 0;padding:12px 14px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0">
        <strong>Temporary password:</strong> <code>${input.tempPassword}</code>
      </p>
      <p style="margin:0 0 12px">Sign in and change your password at first login.</p>
    `,
  );
  return sendEmail({ to: input.to, subject, text, html });
}

export async function sendTicketAssignedEmail(input: {
  to: string;
  assigneeName: string;
  subject: string;
  ticketId: string;
  customerName: string;
  assignedBy?: string;
}) {
  const name = input.assigneeName.trim() || "there";
  const ref = input.ticketId.slice(0, 8).toUpperCase();
  const subject = `Support ticket assigned · ${ref}`;
  const text = [
    `Hi ${name},`,
    "",
    `Ticket ${ref} was assigned to you${input.assignedBy ? ` by ${input.assignedBy}` : ""}.`,
    `Customer: ${input.customerName}`,
    `Subject: ${input.subject}`,
    "",
    "Open Support in the Kipit admin console to reply.",
    "",
    "— Kipit Operations",
  ].join("\n");
  const html = brandWrap(
    "Ticket assigned to you",
    `
      <p style="margin:0 0 12px">Hi ${name},</p>
      <p style="margin:0 0 12px">
        Ticket <strong>${ref}</strong> was assigned to you${
          input.assignedBy ? ` by <strong>${input.assignedBy}</strong>` : ""
        }.
      </p>
      <p style="margin:0 0 8px"><strong>Customer:</strong> ${input.customerName}</p>
      <p style="margin:0 0 12px"><strong>Subject:</strong> ${input.subject}</p>
      <p style="margin:0;color:#64748b">Open <strong>Support</strong> in the admin console to reply.</p>
    `,
  );
  return sendEmail({ to: input.to, subject, text, html });
}

export type CustomerTxnEmailKind =
  | "deposit"
  | "withdrawal"
  | "investment"
  | "withdrawal_result"
  | "auto_invest_failed"
  | "gift_expired";

export async function sendCustomerTxnEmail(input: {
  to: string;
  firstName: string;
  kind: CustomerTxnEmailKind;
  amountNaira: number;
  detail?: string;
}) {
  const labels = {
    deposit: { subject: "Wallet funded", title: "Wallet credited", line: "was added to your Kipit wallet." },
    withdrawal: {
      subject: "Withdrawal request received",
      title: "Withdrawal processing",
      line: "withdrawal request is being processed.",
    },
    investment: {
      subject: "Investment confirmed",
      title: "Investment placed",
      line: "has been invested on your behalf.",
    },
    withdrawal_result: {
      subject: "Withdrawal update",
      title: "Withdrawal update",
      line: input.detail ?? "status was updated.",
    },
    auto_invest_failed: {
      subject: "Auto-invest skipped",
      title: "Auto-invest could not run",
      line: "auto-invest could not be completed.",
    },
    gift_expired: {
      subject: "Gift returned to your wallet",
      title: "Unclaimed gift refunded",
      line: "was returned to your wallet because the gift was not claimed in time.",
    },
  }[input.kind];
  const amount = `₦${input.amountNaira.toLocaleString("en-NG")}`;
  const text = `Hi ${input.firstName},\n\n${amount} ${labels.line}\n${input.detail ? `\n${input.detail}\n` : ""}\n— Kipit Asset Management Limited`;
  const html = brandWrap(
    labels.title,
    `<p style="margin:0 0 12px">Hi ${input.firstName},</p>
     <p style="margin:0 0 12px"><strong style="color:#b98113;font-size:22px">${amount}</strong> ${labels.line}</p>
     ${input.detail ? `<p style="margin:0;color:#64748b">${input.detail}</p>` : ""}`,
  );
  return sendEmail({ to: input.to, subject: labels.subject, text, html });
}

/** Admin withdrawal alert — implemented in admin-alerts (respects Profile alert prefs). */
export { sendOpsWithdrawalAlert } from "./admin-alerts.js";

/** In-app + optional email (respects NotificationPref). */
/**
 * Single entry for in-app + device push (and optional txn email).
 * Always respects NotificationPref push* / email* toggles.
 */
export async function createUserNotification(input: {
  userId: string;
  title: string;
  body: string;
  href?: string;
  pushKind?: PushKind;
  emailKind?: CustomerTxnEmailKind;
  amountNaira?: number;
  emailDetail?: string;
  /** Skip device push (rare). */
  skipPush?: boolean;
}) {
  await prisma.notification.create({
    data: {
      userId: input.userId,
      title: input.title,
      body: input.body,
      href: input.href,
    },
  });

  const pushKind: PushKind =
    input.pushKind ??
    (input.emailKind === "deposit" || input.emailKind === "gift_expired"
      ? "deposit"
      : input.emailKind === "withdrawal" || input.emailKind === "withdrawal_result"
        ? "withdrawal"
        : input.emailKind === "investment" || input.emailKind === "auto_invest_failed"
          ? "investment"
          : "general");

  if (!input.skipPush) {
    await sendPushToUser({
      userId: input.userId,
      title: input.title,
      body: input.body,
      href: input.href,
      kind: pushKind,
    }).catch((err) => console.warn("[notify] push failed", err));
  }

  if (!input.emailKind || input.amountNaira == null) return;

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    include: { notificationPrefs: true },
  });
  if (!user?.email) return;

  const prefs = user.notificationPrefs;
  const allow =
    input.emailKind === "deposit" || input.emailKind === "gift_expired"
      ? prefs?.emailDeposits !== false
      : input.emailKind === "withdrawal" || input.emailKind === "withdrawal_result"
        ? prefs?.emailWithdrawals !== false
        : prefs?.emailInvestments !== false;
  if (!allow) return;

  await sendCustomerTxnEmail({
    to: user.email,
    firstName: user.firstName,
    kind: input.emailKind,
    amountNaira: input.amountNaira,
    detail: input.emailDetail,
  }).catch((err) => console.warn("[notify] email failed", err));
}

/** @deprecated Prefer createUserNotification — kept as alias for existing imports. */
export async function notifyCustomer(input: {
  userId: string;
  title: string;
  body: string;
  href?: string;
  emailKind?: CustomerTxnEmailKind;
  amountNaira?: number;
  emailDetail?: string;
  pushKind?: PushKind;
}) {
  return createUserNotification(input);
}

/** In-app + push when an admin freezes or unfreezes a customer account. */
export async function notifyAccountAccessChange(input: {
  userId: string;
  frozen: boolean;
  reason?: string;
}) {
  const reasonText = input.reason?.trim();
  return createUserNotification({
    userId: input.userId,
    title: input.frozen ? "Account restricted" : "Account restriction lifted",
    body: input.frozen
      ? `Your Kipit account has been temporarily restricted${reasonText ? `: ${reasonText}` : "."} Your money is safe. Contact Kipit support to lift the restriction.`
      : "Your Kipit account access has been restored. You can fund, invest and withdraw again.",
    href: "/settings/help",
    pushKind: "security",
  });
}
