import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { brandWrap, sendEmail } from "./email.js";
import { sendPushToUser, type PushKind } from "./push.js";

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
  const subject = "Welcome to Kipit — a note from the founder";
  const text = [
    `Hi ${name},`,
    "",
    "Welcome to Kipit.",
    "",
    "I'm glad you're here. Kipit is built so more Nigerians can grow wealth with clarity and care — everyday savings earning daily, and fixed plans when you want a target.",
    "",
    "Your money is managed by Kipit Asset Management Limited.",
    input.tempPassword ? `Temporary password: ${input.tempPassword}` : "",
    "",
    "If anything feels unclear, reply to this email or open Ask AI in the app — we're here.",
    "",
    "Warmly,",
    "The Kipit founder",
    "Kipit Asset Management Limited",
  ]
    .filter(Boolean)
    .join("\n");

  const html = brandWrap(
    "Welcome to Kipit",
    `
      <p style="margin:0 0 12px">Hi ${name},</p>
      <p style="margin:0 0 12px">Welcome to Kipit.</p>
      <p style="margin:0 0 12px">I'm glad you're here. Kipit is built so more Nigerians can grow wealth with clarity and care — everyday savings earning daily, and fixed plans when you want a target.</p>
      <p style="margin:0 0 12px">Your money is managed by <strong>Kipit Asset Management Limited</strong>.</p>
      ${tempBlock}
      <p style="margin:0 0 12px">If anything feels unclear, reply to this email or open Ask AI in the app — we're here.</p>
      <p style="margin:16px 0 0">Warmly,<br/><strong>The Kipit founder</strong></p>
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

export async function sendCustomerTxnEmail(input: {
  to: string;
  firstName: string;
  kind: "deposit" | "withdrawal" | "investment" | "withdrawal_result";
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

export async function sendOpsWithdrawalAlert(input: {
  customerName: string;
  customerEmail?: string | null;
  amountNaira: number;
  reference: string;
  withdrawalId: string;
}) {
  const recipients = (env.OPS_ALERT_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!recipients.length) {
    const ops = await prisma.adminUser.findMany({
      where: { active: true, role: { in: ["SUPER", "GLOBAL", "OPERATIONS"] } },
      select: { email: true },
    });
    recipients.push(...ops.map((a) => a.email));
  }
  if (!recipients.length) return { sent: 0 };

  const amount = `₦${input.amountNaira.toLocaleString("en-NG")}`;
  const subject = `Withdrawal request · ${amount} · ${input.reference}`;
  const text = [
    "New withdrawal request",
    `Customer: ${input.customerName}${input.customerEmail ? ` (${input.customerEmail})` : ""}`,
    `Amount: ${amount}`,
    `Reference: ${input.reference}`,
    `Id: ${input.withdrawalId}`,
    "",
    "Review in the Kipit admin console → Withdrawals.",
  ].join("\n");
  const html = brandWrap(
    "Withdrawal request",
    `<p><strong>${input.customerName}</strong> requested <strong style="color:#b98113">${amount}</strong>.</p>
     <p style="color:#64748b;margin:12px 0 0">Reference ${input.reference}</p>
     <p style="margin:16px 0 0">Open <strong>Withdrawals</strong> in the admin console to complete or decline.</p>`,
  );

  await Promise.all(recipients.map((to) => sendEmail({ to, subject, text, html })));
  return { sent: recipients.length };
}

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
  emailKind?: "deposit" | "withdrawal" | "investment" | "withdrawal_result";
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
    (input.emailKind === "deposit"
      ? "deposit"
      : input.emailKind === "withdrawal" || input.emailKind === "withdrawal_result"
        ? "withdrawal"
        : input.emailKind === "investment"
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
    input.emailKind === "deposit"
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
  emailKind?: "deposit" | "withdrawal" | "investment" | "withdrawal_result";
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
