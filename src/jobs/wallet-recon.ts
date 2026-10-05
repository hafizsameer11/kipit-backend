import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { koboToNaira } from "../lib/crypto.js";
import {
  getConfigJson,
  setConfigJson,
  type StoredReconRecord,
} from "../services/admin-ops-store.js";

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const WITHDRAWAL_STALE_MS = 30 * 60 * 1000;
const PENDING_FUNDING_STALE_MS = 15 * 60 * 1000;

type ExceptionDraft = {
  stableKey: string;
  reference: string;
  customerName: string;
  source: string;
  channel: NonNullable<StoredReconRecord["channel"]>;
  internalRef: string;
  providerAmount: number;
  ledgerAmount: number;
  exception: "unmatched" | "variance";
  note: string;
  createdAt: string;
};

function stableId(key: string) {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return `rec_${hash}`;
}

function customerName(user: {
  firstName: string;
  surname?: string | null;
  email?: string | null;
}) {
  const name = `${user.firstName ?? ""} ${user.surname ?? ""}`.trim();
  return name || user.email || "Customer";
}

function sourceForIntent(provider: string, channel: string): string {
  if (provider === "monnify" || channel === "transfer") return "NIBSS transfer";
  if (channel === "card") return "Card acquirer";
  if (provider === "paystack") return "Paystack";
  return "Paystack";
}

function channelForIntent(channel: string): NonNullable<StoredReconRecord["channel"]> {
  if (channel === "card") return "Card";
  if (channel === "transfer") return "Transfer";
  return "Deposit";
}

function metaAmount(meta: unknown, key: string): number | null {
  if (!meta || typeof meta !== "object") return null;
  const raw = (meta as Record<string, unknown>)[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() && !Number.isNaN(Number(raw))) return Number(raw);
  return null;
}

/**
 * Scan wallet funding + withdrawals and upsert open recon exceptions.
 * Preserves investigating/resolved rows and their notes.
 */
export async function runWalletReconJob() {
  const since = new Date(Date.now() - LOOKBACK_MS);
  const now = new Date();
  const drafts: ExceptionDraft[] = [];

  const intents = await prisma.paymentIntent.findMany({
    where: { createdAt: { gte: since } },
    include: {
      user: { select: { firstName: true, surname: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const payKeys = intents.map((i) => `pay-${i.reference}`);
  const depositJournals =
    payKeys.length > 0
      ? await prisma.journalEntry.findMany({
          where: { idempotencyKey: { in: payKeys } },
          select: { idempotencyKey: true, createdAt: true },
        })
      : [];
  const journalByKey = new Set(
    depositJournals.map((j) => j.idempotencyKey).filter(Boolean) as string[],
  );

  for (const intent of intents) {
    const amount = koboToNaira(intent.amountKobo);
    const name = customerName(intent.user);
    const source = sourceForIntent(intent.provider, intent.channel);
    const channel = channelForIntent(intent.channel);
    const createdAt = intent.createdAt.toISOString();
    const ageMs = now.getTime() - intent.createdAt.getTime();

    if (intent.status === "PENDING" && ageMs >= PENDING_FUNDING_STALE_MS) {
      drafts.push({
        stableKey: `pi-pending:${intent.id}`,
        reference: intent.providerRef || intent.reference,
        customerName: name,
        source,
        channel,
        internalRef: intent.reference,
        providerAmount: 0,
        ledgerAmount: amount,
        exception: "unmatched",
        note: `Pending ${intent.provider}/${intent.channel} funding — no provider credit after ${Math.round(ageMs / 60000)}m.`,
        createdAt,
      });
      continue;
    }

    if (intent.status === "SUCCESS") {
      const hasJournal = journalByKey.has(`pay-${intent.reference}`);
      if (!hasJournal) {
        drafts.push({
          stableKey: `pi-noj:${intent.id}`,
          reference: intent.providerRef || intent.reference,
          customerName: name,
          source,
          channel,
          internalRef: intent.reference,
          providerAmount: amount,
          ledgerAmount: 0,
          exception: "unmatched",
          note: "Payment marked SUCCESS but no DEPOSIT journal (pay-{reference}).",
          createdAt: intent.completedAt?.toISOString() ?? createdAt,
        });
        continue;
      }

      const typed = metaAmount(intent.metadata, "typedAmountKobo");
      const credited = metaAmount(intent.metadata, "creditedAmountKobo");
      if (typed != null && credited != null && typed !== credited) {
        drafts.push({
          stableKey: `pi-var:${intent.id}`,
          reference: intent.providerRef || intent.reference,
          customerName: name,
          source,
          channel,
          internalRef: intent.reference,
          providerAmount: koboToNaira(BigInt(Math.trunc(credited))),
          ledgerAmount: koboToNaira(BigInt(Math.trunc(typed))),
          exception: "variance",
          note: "Typed amount differs from credited Monnify amount.",
          createdAt: intent.completedAt?.toISOString() ?? createdAt,
        });
      }
    }
  }

  const withdrawals = await prisma.withdrawalRequest.findMany({
    where: { createdAt: { gte: since } },
    include: {
      user: { select: { firstName: true, surname: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  for (const w of withdrawals) {
    const amount = koboToNaira(w.amountKobo);
    const name = customerName(w.user);
    const createdAt = w.createdAt.toISOString();
    const ageMs = now.getTime() - w.createdAt.getTime();

    if (w.status === "PROCESSING" && ageMs >= WITHDRAWAL_STALE_MS) {
      drafts.push({
        stableKey: `wdr-proc:${w.id}`,
        reference: w.reference,
        customerName: name,
        source: "Paystack",
        channel: "Withdrawal",
        internalRef: w.id,
        providerAmount: 0,
        ledgerAmount: amount,
        exception: "unmatched",
        note: `Withdrawal still PROCESSING after ${Math.round(ageMs / 60000)}m — wallet debit sits in suspense.`,
        createdAt,
      });
      continue;
    }

    if (w.status === "SUCCESSFUL" && !w.providerRef) {
      drafts.push({
        stableKey: `wdr-noref:${w.id}`,
        reference: w.reference,
        customerName: name,
        source: "Paystack",
        channel: "Withdrawal",
        internalRef: w.id,
        providerAmount: 0,
        ledgerAmount: amount,
        exception: "unmatched",
        note: "Withdrawal SUCCESSFUL without provider transfer reference.",
        createdAt: w.processedAt?.toISOString() ?? createdAt,
      });
    }

    if (w.status === "DECLINED") {
      const refund = await prisma.journalEntry.findUnique({
        where: { idempotencyKey: `wdr-decline-${w.id}` },
      });
      if (!refund) {
        drafts.push({
          stableKey: `wdr-decl:${w.id}`,
          reference: w.reference,
          customerName: name,
          source: "Paystack",
          channel: "Withdrawal",
          internalRef: w.id,
          providerAmount: 0,
          ledgerAmount: amount,
          exception: "unmatched",
          note: "Withdrawal DECLINED but decline re-credit journal is missing.",
          createdAt: w.processedAt?.toISOString() ?? createdAt,
        });
      }
    }
  }

  const existing = await getConfigJson<StoredReconRecord[]>("admin.recon.records", []);
  const byId = new Map(existing.map((r) => [r.id, r]));
  const draftIds = new Set<string>();
  const stamp = now.toISOString();

  for (const d of drafts) {
    const id = stableId(d.stableKey);
    draftIds.add(id);
    const prev = byId.get(id);
    const variance = Number((d.providerAmount - d.ledgerAmount).toFixed(2));

    if (prev && (prev.status === "investigating" || prev.status === "resolved")) {
      byId.set(id, {
        ...prev,
        reference: d.reference,
        customerName: d.customerName,
        source: d.source,
        providerAmount: d.providerAmount,
        ledgerAmount: d.ledgerAmount,
        variance,
        channel: d.channel,
        internalRef: d.internalRef,
        exception: d.exception,
        updatedAt: stamp,
      });
      continue;
    }

    const notes = prev?.notes?.length
      ? prev.notes
      : [{ at: stamp, author: "Recon job", body: d.note }];

    byId.set(id, {
      id,
      reference: d.reference,
      customerName: d.customerName,
      source: d.source,
      providerAmount: d.providerAmount,
      ledgerAmount: d.ledgerAmount,
      variance,
      channel: d.channel,
      internalRef: d.internalRef,
      exception: d.exception,
      status: "open",
      notes,
      createdAt: prev?.createdAt ?? d.createdAt,
      updatedAt: stamp,
    });
  }

  // Auto-resolve open exceptions that no longer appear in the scan.
  for (const row of byId.values()) {
    if (row.status !== "open") continue;
    if (draftIds.has(row.id)) continue;
    // Only auto-clear job-managed ids (stable hash prefix).
    if (!row.id.startsWith("rec_")) continue;
    row.status = "resolved";
    row.notes = [
      ...row.notes,
      {
        at: stamp,
        author: "Recon job",
        body: "Auto-resolved — exception no longer present on latest scan.",
      },
    ];
    row.updatedAt = stamp;
  }

  const next = [...byId.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  // Cap store growth.
  const trimmed = next.slice(0, 500);
  await setConfigJson("admin.recon.records", trimmed, "wallet-recon-job");
  await setConfigJson(
    "admin.recon.lastRunAt",
    { at: stamp },
    "wallet-recon-job",
  );

  const open = trimmed.filter((r) => r.status === "open").length;
  return {
    scannedIntents: intents.length,
    scannedWithdrawals: withdrawals.length,
    exceptions: drafts.length,
    open,
    total: trimmed.length,
  };
}

/** Throttled entry used by GET /admin/recon so page loads stay fresh without hammering. */
export async function runWalletReconJobThrottled(minIntervalMs = 60_000) {
  const last = await getConfigJson<{ at?: string }>("admin.recon.lastRunAt", {});
  if (last.at) {
    const age = Date.now() - new Date(last.at).getTime();
    if (Number.isFinite(age) && age >= 0 && age < minIntervalMs) {
      return { skipped: true as const, ageMs: age };
    }
  }
  const result = await runWalletReconJob();
  return { skipped: false as const, ...result };
}
