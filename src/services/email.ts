import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../lib/env.js";

let transporter: Transporter | null = null;

function smtpConfigured() {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

function getTransporter() {
  if (!smtpConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

export type SendEmailAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Optional — existing callers omit this; SMTP only for now. */
  attachments?: SendEmailAttachment[];
};

/** Shared Kipit branded HTML shell for all customer emails. */
export function brandWrap(title: string, bodyHtml: string) {
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

/** Branded notice email — no deep links / CTA buttons. */
export async function sendBrandedNoticeEmail(input: {
  to: string;
  firstName?: string | null;
  subject: string;
  title: string;
  body: string;
}) {
  const name = (input.firstName || "").trim() || "there";
  const greeting = `Hi ${name},`;
  const text = [greeting, "", input.body, "", "— Kipit Asset Management Limited"].join("\n");
  const html = brandWrap(
    input.title,
    `<p style="margin:0 0 12px">${greeting}</p>
     <p style="margin:0;white-space:pre-line">${input.body}</p>`,
  );
  return sendEmail({ to: input.to, subject: input.subject, text, html });
}

/**
 * Send email via Hostinger SMTP (or any SMTP).
 * EMAIL_PROVIDER=resend is reserved for later — falls back to SMTP/console for now.
 */
export async function sendEmail(input: SendEmailInput) {
  const from = env.EMAIL_FROM || env.SMTP_USER;

  if (env.EMAIL_PROVIDER === "resend" && env.RESEND_API_KEY) {
    // Placeholder until Resend is activated — use SMTP if available, else log.
    console.warn("[email] EMAIL_PROVIDER=resend but Resend not wired yet; using SMTP/console");
  }

  const tx = getTransporter();
  if (tx && from) {
    const info = await tx.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html ?? input.text.replace(/\n/g, "<br/>"),
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
    return { id: info.messageId, provider: "smtp" as const };
  }

  // Dev / misconfigured: log instead of failing the auth flow.
  console.info("[email:console]", {
    from: from || "(unset)",
    to: input.to,
    subject: input.subject,
    text: input.text,
    attachments: input.attachments?.map((a) => a.filename) ?? [],
  });
  return { id: `console-${Date.now()}`, provider: "console" as const };
}

export async function sendOtpEmail(input: {
  to: string;
  code: string;
  purpose: string;
}) {
  const purposeLabel: Record<string, string> = {
    SIGNUP: "verify your Kipit account",
    LOGIN: "sign in to Kipit",
    PASSWORD_RESET: "reset your Kipit password",
    PIN_RESET: "reset your Kipit transaction PIN",
    ADMIN_LOGIN: "sign in to the Kipit admin console",
  };
  const action = purposeLabel[input.purpose] ?? "continue with Kipit";
  const subject = `Your Kipit code: ${input.code}`;
  const text = [
    `Your verification code is ${input.code}.`,
    "",
    `Use this code to ${action}.`,
    "It expires in 10 minutes.",
    "",
    "If you did not request this, you can ignore this email.",
    "",
    "— Kipit",
  ].join("\n");

  const html = brandWrap(
    "Verification code",
    `<p style="margin:0 0 16px;line-height:1.5">Use this code to ${action}:</p>
     <p style="font-size:32px;font-weight:800;letter-spacing:0.2em;margin:0 0 16px">${input.code}</p>
     <p style="margin:0;color:#64748b;font-size:13px;line-height:1.5">Expires in 10 minutes. If you did not request this, ignore this email.</p>`,
  );

  return sendEmail({ to: input.to, subject, text, html });
}

export function emailTransportReady() {
  return smtpConfigured() || (env.EMAIL_PROVIDER === "resend" && Boolean(env.RESEND_API_KEY));
}

/** Invite a non-Kipit recipient to download the app and claim a gift. */
export async function sendGiftInviteEmail(input: {
  to: string;
  recipientName?: string | null;
  senderFirstName: string;
  amountNaira: number;
  claimCode: string;
  claimLink: string;
  message?: string | null;
}) {
  const name = (input.recipientName || "").trim() || "there";
  const amount = `₦${input.amountNaira.toLocaleString("en-NG")}`;
  const subject = `${input.senderFirstName} sent you a ${amount} Kipit gift`;
  const note = (input.message || "").trim();
  const text = [
    `Hi ${name},`,
    "",
    `${input.senderFirstName} sent you a ${amount} investment gift on Kipit.`,
    note ? `Message: "${note}"` : null,
    "",
    "Create a free Kipit account with this email to claim it into your portfolio:",
    input.claimLink,
    "",
    `Claim code: ${input.claimCode}`,
    "",
    "— Kipit Asset Management Limited",
  ]
    .filter((line) => line != null)
    .join("\n");

  const html = brandWrap(
    "You've received a Kipit gift",
    `<p style="margin:0 0 12px">Hi ${name},</p>
     <p style="margin:0 0 12px"><strong>${input.senderFirstName}</strong> sent you a <strong>${amount}</strong> investment gift on Kipit.</p>
     ${note ? `<p style="margin:0 0 12px;padding:12px;border-radius:12px;background:#f7f9fc;border:1px solid #e2e8f0">“${note}”</p>` : ""}
     <p style="margin:0 0 16px">Create a free Kipit account with this email address to claim it into your portfolio.</p>
     <p style="margin:0 0 16px"><a href="${input.claimLink}" style="display:inline-block;background:#0b1d3a;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:999px">Claim your gift</a></p>
     <p style="margin:0;color:#64748b;font-size:13px">Or open this link: ${input.claimLink}<br/>Claim code: <strong>${input.claimCode}</strong></p>`,
  );

  return sendEmail({ to: input.to, subject, text, html });
}
