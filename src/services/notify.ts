import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { sendEmail } from "./email.js";

function brandWrap(title: string, bodyHtml: string) {
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0b1d3a;background:#f7f9fc">
      <div style="background:#0b1d3a;color:#fff;border-radius:16px 16px 0 0;padding:20px 24px">
        <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#eab333;font-weight:700">Kipit Asset Management</div>
        <h1 style="font-size:22px;margin:8px 0 0;font-weight:800">${title}</h1>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 16px 16px;padding:24px;line-height:1.55">
        ${bodyHtml}
        <p style="margin:24px 0 0;color:#64748b;font-size:12px;line-height:1.5">
          Kipit is powered by Kipit Asset Management Limited. All funds are managed by Kipit Asset Management Limited.
        </p>
      </div>
    </div>
  `;
}

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
export async function notifyCustomer(input: {
  userId: string;
  title: string;
  body: string;
  href?: string;
  emailKind?: "deposit" | "withdrawal" | "investment" | "withdrawal_result";
  amountNaira?: number;
  emailDetail?: string;
}) {
  await prisma.notification.create({
    data: {
      userId: input.userId,
      title: input.title,
      body: input.body,
      href: input.href,
    },
  });

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
