import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { brandWrap, sendEmail } from "./email.js";
import { getConfigJson, setConfigJson } from "./admin-ops-store.js";
import {
  permissionsForRole,
  type AdminPermission,
} from "./admin-permissions.js";

export type AdminAlertKind =
  | "withdrawalApprovals"
  | "amlEscalations"
  | "reconVariances"
  | "rateApprovals"
  | "dailyOpsDigest";

export type AdminAlertPrefs = Record<AdminAlertKind, boolean>;

export const DEFAULT_ADMIN_ALERT_PREFS: AdminAlertPrefs = {
  withdrawalApprovals: true,
  amlEscalations: true,
  reconVariances: true,
  rateApprovals: false,
  dailyOpsDigest: true,
};

function prefsKey(adminId: string) {
  return `admin.alertPrefs.${adminId}`;
}

export async function getAdminAlertPrefs(adminId: string): Promise<AdminAlertPrefs> {
  const stored = await getConfigJson<Partial<AdminAlertPrefs>>(prefsKey(adminId), {});
  return { ...DEFAULT_ADMIN_ALERT_PREFS, ...stored };
}

export async function setAdminAlertPrefs(
  adminId: string,
  patch: Partial<AdminAlertPrefs>,
): Promise<AdminAlertPrefs> {
  const next = { ...(await getAdminAlertPrefs(adminId)), ...patch };
  await setConfigJson(prefsKey(adminId), next, adminId);
  return next;
}

type AdminRecipient = { id: string; email: string; name: string };

/** Admins with a given alert preference on, optionally filtered by permission. */
export async function recipientsForAlert(
  kind: AdminAlertKind,
  opts?: {
    permission?: AdminPermission;
    /** Prefer a single assignee (by email or name match). */
    assignee?: string | null;
    excludeAdminId?: string | null;
  },
): Promise<AdminRecipient[]> {
  const rows = await prisma.adminUser.findMany({
    where: { active: true },
    select: { id: true, email: true, name: true, role: true },
  });

  const out: AdminRecipient[] = [];
  for (const row of rows) {
    if (opts?.excludeAdminId && row.id === opts.excludeAdminId) continue;
    const prefs = await getAdminAlertPrefs(row.id);
    if (!prefs[kind]) continue;
    if (opts?.permission) {
      const perms = await permissionsForRole(row.role);
      if (!perms.includes(opts.permission)) continue;
    }
    if (opts?.assignee?.trim()) {
      const needle = opts.assignee.trim().toLowerCase();
      const match =
        row.email.toLowerCase() === needle ||
        row.name.toLowerCase() === needle ||
        row.name.toLowerCase().includes(needle);
      if (!match) continue;
    }
    out.push({ id: row.id, email: row.email, name: row.name });
  }
  return out;
}

async function sendToRecipients(
  recipients: AdminRecipient[],
  subject: string,
  text: string,
  htmlBody: string,
  title: string,
) {
  if (!recipients.length) return { sent: 0 };
  const html = brandWrap(title, htmlBody);
  await Promise.all(
    recipients.map((r) =>
      sendEmail({ to: r.email, subject, text, html }).catch((err) =>
        console.warn("[admin-alerts] email failed", r.email, err),
      ),
    ),
  );
  return { sent: recipients.length };
}

/** Withdrawal approvals — respects prefs; falls back to OPS_ALERT_EMAILS then role list. */
export async function sendOpsWithdrawalAlert(input: {
  customerName: string;
  customerEmail?: string | null;
  amountNaira: number;
  reference: string;
  withdrawalId: string;
}) {
  let recipients = await recipientsForAlert("withdrawalApprovals", {
    permission: "withdrawal.process",
  });

  if (!recipients.length) {
    const envList = (env.OPS_ALERT_EMAILS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (envList.length) {
      recipients = envList.map((email) => ({ id: email, email, name: "Ops" }));
    } else {
      const ops = await prisma.adminUser.findMany({
        where: { active: true, role: { in: ["SUPER", "GLOBAL", "OPERATIONS"] } },
        select: { id: true, email: true, name: true },
      });
      const filtered: AdminRecipient[] = [];
      for (const a of ops) {
        const prefs = await getAdminAlertPrefs(a.id);
        if (prefs.withdrawalApprovals) filtered.push(a);
      }
      recipients = filtered;
    }
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
  const htmlBody = `<p><strong>${input.customerName}</strong> requested <strong style="color:#b98113">${amount}</strong>.</p>
     <p style="color:#64748b;margin:12px 0 0">Reference ${input.reference}</p>
     <p style="margin:16px 0 0">Open <strong>Withdrawals</strong> in the admin console to complete or decline.</p>`;

  return sendToRecipients(recipients, subject, text, htmlBody, "Withdrawal request");
}

export async function sendAmlEscalationAlert(input: {
  alertId: string;
  customerName: string;
  rule: string;
  severity: string;
  status: string;
  assignee?: string | null;
  amount?: number;
}) {
  let recipients = await recipientsForAlert("amlEscalations", {
    permission: "aml.investigate",
    assignee: input.assignee,
  });
  // If assignee didn't match anyone, fall back to all AML investigators with the pref on.
  if (input.assignee?.trim() && !recipients.length) {
    recipients = await recipientsForAlert("amlEscalations", {
      permission: "aml.investigate",
    });
  }
  if (!recipients.length) return { sent: 0 };

  const amount =
    input.amount != null ? `₦${input.amount.toLocaleString("en-NG")}` : null;
  const subject = `AML ${input.status} · ${input.customerName} · ${input.severity}`;
  const text = [
    "AML alert update",
    `Customer: ${input.customerName}`,
    `Rule: ${input.rule}`,
    `Severity: ${input.severity}`,
    `Status: ${input.status}`,
    input.assignee ? `Assignee: ${input.assignee}` : "",
    amount ? `Amount: ${amount}` : "",
    `Id: ${input.alertId}`,
    "",
    "Open Compliance → AML in the Kipit admin console.",
  ]
    .filter(Boolean)
    .join("\n");
  const htmlBody = `
    <p style="margin:0 0 12px">AML alert <strong>${input.status}</strong> for <strong>${input.customerName}</strong>.</p>
    <p style="margin:0 0 8px"><strong>Rule:</strong> ${input.rule}</p>
    <p style="margin:0 0 8px"><strong>Severity:</strong> ${input.severity}</p>
    ${input.assignee ? `<p style="margin:0 0 8px"><strong>Assignee:</strong> ${input.assignee}</p>` : ""}
    ${amount ? `<p style="margin:0 0 8px"><strong>Amount:</strong> ${amount}</p>` : ""}
    <p style="margin:16px 0 0;color:#64748b">Open <strong>Compliance → AML</strong> in the admin console.</p>
  `;
  return sendToRecipients(recipients, subject, text, htmlBody, "AML alert");
}

export async function sendReconVarianceAlert(input: {
  openCount: number;
  exceptions: number;
}) {
  if (input.openCount <= 0) return { sent: 0, skipped: true as const };

  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
  }).format(new Date());
  const last = await getConfigJson<{ dateKey?: string }>("admin.recon.lastAlert", {});
  if (last.dateKey === dateKey) return { sent: 0, skipped: true as const };

  const recipients = await recipientsForAlert("reconVariances", {
    permission: "recon.resolve",
  });
  if (!recipients.length) return { sent: 0, skipped: false as const };

  const subject = `Reconciliation · ${input.openCount} open unmatched / variance`;
  const text = [
    "Daily reconciliation summary",
    `Open exceptions: ${input.openCount}`,
    `New / refreshed this run: ${input.exceptions}`,
    "",
    "Open Reconciliation in the Kipit admin console.",
  ].join("\n");
  const htmlBody = `
    <p style="margin:0 0 12px"><strong style="color:#b98113;font-size:22px">${input.openCount}</strong> open unmatched / variance items.</p>
    <p style="margin:0 0 12px;color:#64748b">${input.exceptions} exceptions on the latest scan.</p>
    <p style="margin:16px 0 0">Open <strong>Reconciliation</strong> in the admin console.</p>
  `;
  const result = await sendToRecipients(
    recipients,
    subject,
    text,
    htmlBody,
    "Reconciliation variances",
  );
  if (result.sent > 0) {
    await setConfigJson("admin.recon.lastAlert", { dateKey, at: new Date().toISOString() }, "wallet-recon-job");
  }
  return { ...result, skipped: false as const };
}

export async function sendRateApprovalAlert(input: {
  requestId: string;
  bandName: string;
  proposedBps: number;
  previousBps: number;
  effectiveFrom: string;
  makerAdminId: string;
  makerName?: string;
}) {
  const recipients = await recipientsForAlert("rateApprovals", {
    permission: "rate.approve",
    excludeAdminId: input.makerAdminId,
  });
  if (!recipients.length) return { sent: 0 };

  const proposed = `${(input.proposedBps / 100).toFixed(2)}%`;
  const previous = `${(input.previousBps / 100).toFixed(2)}%`;
  const subject = `Rate proposal awaiting approval · ${input.bandName}`;
  const text = [
    "Rate change proposal",
    `Band: ${input.bandName}`,
    `Proposed: ${proposed} (was ${previous})`,
    `Effective: ${input.effectiveFrom}`,
    input.makerName ? `Maker: ${input.makerName}` : "",
    `Id: ${input.requestId}`,
    "",
    "Open Products → Rates in the Kipit admin console to approve or reject.",
  ]
    .filter(Boolean)
    .join("\n");
  const htmlBody = `
    <p style="margin:0 0 12px">A rate change for <strong>${input.bandName}</strong> is awaiting a checker.</p>
    <p style="margin:0 0 8px"><strong>Proposed:</strong> ${proposed} <span style="color:#64748b">(was ${previous})</span></p>
    <p style="margin:0 0 8px"><strong>Effective:</strong> ${input.effectiveFrom}</p>
    ${input.makerName ? `<p style="margin:0 0 8px"><strong>Maker:</strong> ${input.makerName}</p>` : ""}
    <p style="margin:16px 0 0;color:#64748b">Open <strong>Products → Rates</strong> to approve or reject.</p>
  `;
  return sendToRecipients(recipients, subject, text, htmlBody, "Rate proposal");
}

export async function runOpsDigestJob() {
  const recipients = await recipientsForAlert("dailyOpsDigest");
  if (!recipients.length) return { sent: 0, skipped: true as const };

  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
  }).format(new Date());
  const last = await getConfigJson<{ dateKey?: string }>("admin.opsDigest.lastSent", {});
  if (last.dateKey === dateKey) return { sent: 0, skipped: true as const };

  const [pendingWithdrawals, pendingRates, amlAlerts, reconRecords] = await Promise.all([
    prisma.withdrawalRequest.count({ where: { status: "PROCESSING" } }),
    prisma.rateChangeRequest.count({ where: { status: "PENDING" } }),
    getConfigJson<{ status: string }[]>("admin.aml.alerts", []),
    getConfigJson<{ status: string }[]>("admin.recon.records", []),
  ]);

  const openAml = amlAlerts.filter((a) => a.status === "open" || a.status === "escalated").length;
  const openRecon = reconRecords.filter((r) => r.status === "open" || r.status === "investigating").length;

  const subject = `Kipit ops digest · ${dateKey}`;
  const text = [
    `Daily operations digest — ${dateKey}`,
    "",
    `Pending withdrawals: ${pendingWithdrawals}`,
    `Open AML alerts: ${openAml}`,
    `Open recon exceptions: ${openRecon}`,
    `Pending rate approvals: ${pendingRates}`,
    "",
    "— Kipit Operations",
  ].join("\n");
  const htmlBody = `
    <p style="margin:0 0 16px">Morning summary for <strong>${dateKey}</strong>.</p>
    <ul style="margin:0;padding-left:18px;line-height:1.8">
      <li><strong>${pendingWithdrawals}</strong> pending withdrawals</li>
      <li><strong>${openAml}</strong> open AML alerts</li>
      <li><strong>${openRecon}</strong> open recon exceptions</li>
      <li><strong>${pendingRates}</strong> pending rate approvals</li>
    </ul>
    <p style="margin:16px 0 0;color:#64748b">Open the Kipit admin console to action items.</p>
  `;

  const result = await sendToRecipients(
    recipients,
    subject,
    text,
    htmlBody,
    "Daily operations digest",
  );
  if (result.sent > 0) {
    await setConfigJson(
      "admin.opsDigest.lastSent",
      { dateKey, at: new Date().toISOString() },
      "ops-digest-job",
    );
  }
  return { ...result, skipped: false as const, pendingWithdrawals, openAml, openRecon, pendingRates };
}
