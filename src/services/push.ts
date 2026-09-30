import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";

export type PushKind =
  | "deposit"
  | "withdrawal"
  | "investment"
  | "maturity"
  | "product"
  | "security"
  | "kyc"
  | "general";

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  channelId?: string;
  priority?: "default" | "normal" | "high";
};

function prefAllows(
  prefs: {
    pushDeposits: boolean;
    pushWithdrawals: boolean;
    pushInvestments: boolean;
    pushMaturities: boolean;
    pushProducts: boolean;
    pushSecurity: boolean;
    pushKyc: boolean;
  } | null,
  kind: PushKind,
) {
  if (!prefs) return true;
  switch (kind) {
    case "deposit":
      return prefs.pushDeposits !== false;
    case "withdrawal":
      return prefs.pushWithdrawals !== false;
    case "investment":
      return prefs.pushInvestments !== false;
    case "maturity":
      return prefs.pushMaturities !== false;
    case "product":
      return prefs.pushProducts !== false;
    case "security":
      return prefs.pushSecurity !== false;
    case "kyc":
      return prefs.pushKyc !== false;
    default:
      return true;
  }
}

/** Register or refresh an Expo push token for a user. */
export async function upsertPushDevice(input: {
  userId: string;
  token: string;
  platform?: string;
  deviceName?: string;
}) {
  const token = input.token.trim();
  if (!token || token.length < 20) {
    throw new Error("Invalid push token");
  }
  return prisma.pushDevice.upsert({
    where: { token },
    create: {
      userId: input.userId,
      token,
      platform: input.platform,
      deviceName: input.deviceName,
    },
    update: {
      userId: input.userId,
      platform: input.platform,
      deviceName: input.deviceName,
    },
  });
}

export async function removePushDevice(input: { userId: string; token?: string }) {
  if (input.token) {
    await prisma.pushDevice.deleteMany({
      where: { userId: input.userId, token: input.token.trim() },
    });
    return;
  }
  await prisma.pushDevice.deleteMany({ where: { userId: input.userId } });
}

async function postExpoPush(messages: ExpoPushMessage[]) {
  if (!messages.length) return;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (env.EXPO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
  }
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers,
    body: JSON.stringify(messages),
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: Array<{ status?: string; details?: { error?: string }; message?: string }>;
  };
  if (!res.ok) {
    console.warn("[push] Expo send failed", res.status, json);
    return;
  }

  // Drop tokens Expo says are gone / invalid.
  const tickets = Array.isArray(json.data) ? json.data : [];
  const stale: string[] = [];
  tickets.forEach((ticket, i) => {
    const err = ticket?.details?.error || ticket?.message || "";
    if (
      ticket?.status === "error" &&
      /DeviceNotRegistered|InvalidCredentials|ExpoPushToken/i.test(String(err))
    ) {
      const to = messages[i]?.to;
      if (to) stale.push(to);
    }
  });
  if (stale.length) {
    await prisma.pushDevice.deleteMany({ where: { token: { in: stale } } });
  }
}

/** Send a device push to every registered token for the user (respects prefs). */
export async function sendPushToUser(input: {
  userId: string;
  title: string;
  body: string;
  href?: string;
  kind?: PushKind;
}) {
  const kind = input.kind ?? "general";
  const [prefs, devices] = await Promise.all([
    prisma.notificationPref.findUnique({ where: { userId: input.userId } }),
    prisma.pushDevice.findMany({ where: { userId: input.userId } }),
  ]);
  if (!prefAllows(prefs, kind) || !devices.length) return;

  const messages: ExpoPushMessage[] = devices.map((d) => ({
    to: d.token,
    title: input.title,
    body: input.body,
    sound: "default",
    channelId: "kipit-default",
    priority: "high",
    data: {
      href: input.href ?? null,
      kind,
    },
  }));

  // Expo accepts batches of up to 100.
  for (let i = 0; i < messages.length; i += 100) {
    await postExpoPush(messages.slice(i, i + 100)).catch((err) =>
      console.warn("[push] send error", err),
    );
  }
}
