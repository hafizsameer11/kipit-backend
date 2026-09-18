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

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

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
    });
    return { id: info.messageId, provider: "smtp" as const };
  }

  // Dev / misconfigured: log instead of failing the auth flow.
  console.info("[email:console]", {
    from: from || "(unset)",
    to: input.to,
    subject: input.subject,
    text: input.text,
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

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0b1d3a">
      <h1 style="font-size:20px;margin:0 0 12px">Kipit verification</h1>
      <p style="margin:0 0 16px;line-height:1.5">Use this code to ${action}:</p>
      <p style="font-size:32px;font-weight:800;letter-spacing:0.2em;margin:0 0 16px">${input.code}</p>
      <p style="margin:0;color:#64748b;font-size:13px;line-height:1.5">Expires in 10 minutes. If you did not request this, ignore this email.</p>
    </div>
  `;

  return sendEmail({ to: input.to, subject, text, html });
}

export function emailTransportReady() {
  return smtpConfigured() || (env.EMAIL_PROVIDER === "resend" && Boolean(env.RESEND_API_KEY));
}
