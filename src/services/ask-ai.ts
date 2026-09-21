import { env, askAiLlmEnabled, openaiBaseUrl } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import { koboToNaira } from "../lib/crypto.js";
import { ensureUserCall, getWalletBalanceKobo } from "./money.js";

export type ChatUiBlock = Record<string, unknown>;

export type AskAiReply = {
  text: string;
  blocks: ChatUiBlock[];
  mode: "llm" | "rules";
};

type ChatMsg = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; name?: string; tool_calls?: ToolCall[] };

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type CompletionMessage = {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
};

const SYSTEM_PROMPT = `You are Kipit Ask AI — a helpful assistant inside the Kipit investment app (Nigeria).

Rules:
- Be concise, warm, and clear. Use ₦ for amounts.
- NEVER move money, change PIN, approve withdrawals, or invent balances/rates.
- Only use numbers returned by tools. If a tool fails, say you could not load live data.
- For funding, investing, or withdrawals, explain briefly and call suggest_handoff so the app shows a secure continue button.
- For support issues you cannot resolve with tools, help the user file a support ticket via create_support_ticket (confirm category/subject/details first), or list_support_tickets to show open cases.
- You confirm nothing with PIN in chat — the user does that on the secure screen.
- If the user asks something outside Kipit (general investing/KYC literacy is OK), answer briefly and steer back to Kipit when useful.
- Prefer short answers (2–4 sentences) plus tools for cards/CTAs.`;

const TICKET_CATEGORIES = [
  "Deposits & wallet",
  "Withdrawals & payouts",
  "Investments & plans",
  "Account & verification",
  "Something else",
] as const;

const ALLOWED_HANDOFFS = new Set([
  "/portfolio",
  "/wallet/add-money",
  "/wallet/card",
  "/invest",
  "/explore",
  "/withdraw",
  "/portfolio/transactions",
  "/portfolio/maturities",
  "/settings/verification",
  "/settings/help",
  "/settings/help/ticket",
  "/settings/help/tickets",
  "/fixed-plans/create",
]);

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_balance",
      description: "Get the user's live wallet, invested, and total portfolio values in Naira.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_next_maturity",
      description: "Get the user's next upcoming investment maturity, if any.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_products",
      description: "List open investment products and fixed-plan rate bands the user can browse.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_kyc_status",
      description: "Get the user's KYC tier and verification status.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "suggest_handoff",
      description: "Attach a secure in-app deep link button (never moves money by itself).",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Button label, e.g. Add Money" },
          to: {
            type: "string",
            description:
              "App path: /portfolio, /wallet/add-money, /invest, /explore, /withdraw, /portfolio/transactions, /settings/verification, /fixed-plans/create",
          },
        },
        required: ["label", "to"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "suggest_chips",
      description: "Offer quick follow-up suggestion chips the user can tap.",
      parameters: {
        type: "object",
        properties: {
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 4,
          },
        },
        required: ["options"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_support_tickets",
      description: "List the user's recent support tickets and statuses.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_support_ticket",
      description:
        "File a support ticket for the user after they confirm the issue. Use one of the allowed categories.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [...TICKET_CATEGORIES],
            description: "Ticket category",
          },
          subject: { type: "string", description: "Short subject line" },
          body: {
            type: "string",
            description: "Detailed description of the issue, including references if any",
          },
        },
        required: ["category", "subject", "body"],
        additionalProperties: false,
      },
    },
  },
];

function safeHandoffPath(to: string): string | null {
  const path = to.trim().split("?")[0] || "";
  if (ALLOWED_HANDOFFS.has(path)) return path;
  // Allow /explore/:id/subscribe and /portfolio/:id
  if (/^\/explore\/[a-zA-Z0-9_-]+\/subscribe$/.test(path)) return path;
  if (/^\/portfolio\/[a-zA-Z0-9_-]+$/.test(path)) return path;
  if (/^\/settings\/help\/tickets\/[a-zA-Z0-9_-]+$/.test(path)) return path;
  return null;
}

async function runTool(
  userId: string,
  name: string,
  argsJson: string,
  blocks: ChatUiBlock[],
): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch {
    args = {};
  }

  if (name === "get_balance") {
    const wallet = await getWalletBalanceKobo(userId);
    const call = await ensureUserCall(userId);
    const placements = await prisma.placement.findMany({
      where: { userId, status: "ACTIVE" },
    });
    const invested = placements.reduce((s, p) => s + p.principalKobo, 0n) + call.balanceKobo;
    const total = wallet + invested;
    const payload = {
      wallet: koboToNaira(wallet),
      invested: koboToNaira(invested),
      total: koboToNaira(total),
      holdings: placements.length + (call.balanceKobo > 0n ? 1 : 0),
      currency: "NGN",
    };
    blocks.push({
      kind: "balance",
      wallet: payload.wallet,
      invested: payload.invested,
      total: payload.total,
      holdings: payload.holdings,
    });
    return payload;
  }

  if (name === "get_next_maturity") {
    const next = await prisma.placement.findFirst({
      where: { userId, status: "ACTIVE", maturityDate: { not: null } },
      orderBy: { maturityDate: "asc" },
    });
    if (!next?.maturityDate) {
      return { found: false };
    }
    const daysLeft = Math.max(
      0,
      Math.ceil((next.maturityDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
    );
    const payload = {
      found: true,
      id: next.id,
      name: next.name,
      date: next.maturityDate.toISOString().slice(0, 10),
      amount: koboToNaira(next.principalKobo),
      rate: `${next.rateBps / 100}% p.a.`,
      daysLeft,
      expectedPayout: koboToNaira(next.principalKobo + next.accruedKobo),
    };
    blocks.push({
      kind: "maturity",
      name: payload.name,
      date: payload.date,
      amount: payload.amount,
      rate: payload.rate,
      daysLeft: payload.daysLeft,
      expectedPayout: payload.expectedPayout,
    });
    return payload;
  }

  if (name === "list_products") {
    const products = await prisma.product.findMany({
      where: { availability: "OPEN" },
      take: 5,
    });
    const bands = await prisma.rateBand.findMany({ orderBy: { minDays: "asc" }, take: 4 });
    const list = [
      ...bands
        .filter((b) => b.code !== "CALL")
        .slice(0, 2)
        .map((b) => ({
          name: b.label,
          rate: `${b.rateBps / 100}% p.a.`,
          tenor: b.maxDays ? `${b.minDays}-${b.maxDays} days` : `${b.minDays}+ days`,
          minimum: 10000,
          to: "/fixed-plans/create",
        })),
      ...products.map((p) => ({
        name: p.name,
        rate: `${p.rateBps / 100}% p.a.`,
        tenor: `${p.tenorDays} days`,
        minimum: koboToNaira(p.minimumKobo),
        to: `/explore/${p.id}/subscribe`,
      })),
    ];
    blocks.push({ kind: "products", products: list });
    return { products: list };
  }

  if (name === "get_kyc_status") {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { kycProfile: true },
    });
    return {
      tier: user.kycTier,
      status: user.kycProfile?.status ?? "NOT_STARTED",
      rejectionReason: user.kycProfile?.rejectionReason ?? null,
    };
  }

  if (name === "suggest_handoff") {
    const label = String(args.label || "Continue").slice(0, 40);
    const to = safeHandoffPath(String(args.to || ""));
    if (!to) return { ok: false, error: "Path not allowed" };
    blocks.push({ kind: "handoff", label, to });
    return { ok: true, label, to };
  }

  if (name === "suggest_chips") {
    const options = Array.isArray(args.options)
      ? args.options.map((o) => String(o).slice(0, 60)).filter(Boolean).slice(0, 4)
      : [];
    if (options.length) blocks.push({ kind: "chips", options });
    return { ok: true, options };
  }

  if (name === "list_support_tickets") {
    const rows = await prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const tickets = rows.map((t) => ({
      id: t.id,
      category: t.category,
      subject: t.subject,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));
    blocks.push({
      kind: "chips",
      options: [
        { label: "View my tickets", send: "Show my support tickets" },
        { label: "New ticket", send: "I need to submit a support ticket" },
      ],
    });
    blocks.push({ kind: "handoff", label: "Open ticket list", to: "/settings/help/tickets" });
    return { count: tickets.length, tickets };
  }

  if (name === "create_support_ticket") {
    const category = String(args.category || "").trim();
    const subject = String(args.subject || "").trim().slice(0, 160);
    const detail = String(args.body || "").trim().slice(0, 4000);
    if (!TICKET_CATEGORIES.includes(category as (typeof TICKET_CATEGORIES)[number])) {
      return { ok: false, error: "Invalid category", allowed: TICKET_CATEGORIES };
    }
    if (subject.length < 3 || detail.length < 10) {
      return { ok: false, error: "Subject and description need more detail before filing." };
    }
    const ticket = await prisma.supportTicket.create({
      data: { userId, category, subject, body: detail },
    });
    await prisma.notification.create({
      data: {
        userId,
        title: "Support ticket received",
        body: `We've logged “${ticket.subject}”. Our team typically replies within one business day.`,
        href: `/settings/help/tickets/${ticket.id}`,
      },
    });
    blocks.push({
      kind: "chips",
      options: [
        { label: "View ticket", send: `Show ticket ${ticket.id}` },
        { label: "My tickets", send: "Show my support tickets" },
      ],
    });
    blocks.push({ kind: "handoff", label: "View my tickets", to: "/settings/help/tickets" });
    return {
      ok: true,
      id: ticket.id,
      status: ticket.status,
      category: ticket.category,
      subject: ticket.subject,
    };
  }

  return { error: `Unknown tool: ${name}` };
}

async function chatCompletions(messages: ChatMsg[]): Promise<CompletionMessage> {
  const url = `${openaiBaseUrl()}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.4,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: CompletionMessage }>;
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error("LLM returned empty choices");
  return message;
}

/** Rule-based Ask AI — used when no OPENAI_API_KEY is configured. */
export async function buildRuleBasedReply(userId: string, raw: string): Promise<AskAiReply> {
  const text = raw.toLowerCase();
  const wallet = await getWalletBalanceKobo(userId);
  const call = await ensureUserCall(userId);
  const placements = await prisma.placement.findMany({
    where: { userId, status: "ACTIVE" },
    orderBy: { maturityDate: "asc" },
  });
  const invested = placements.reduce((s, p) => s + p.principalKobo, 0n) + call.balanceKobo;
  const total = wallet + invested;

  if (/(balance|portfolio|worth|wallet)/.test(text)) {
    return {
      mode: "rules",
      text: `Your current portfolio value is ₦${koboToNaira(total).toLocaleString()}.`,
      blocks: [
        { kind: "balance", wallet: koboToNaira(wallet), invested: koboToNaira(invested), total: koboToNaira(total) },
        { kind: "handoff", label: "View Portfolio", to: "/portfolio" },
      ],
    };
  }

  if (/(mature|maturity|payout date)/.test(text)) {
    const next = placements.find((p) => p.maturityDate);
    if (!next?.maturityDate) {
      return {
        mode: "rules",
        text: "You have no upcoming maturities yet.",
        blocks: [{ kind: "handoff", label: "Explore products", to: "/explore" }],
      };
    }
    return {
      mode: "rules",
      text: `Your next maturity is on ${next.maturityDate.toISOString().slice(0, 10)}.`,
      blocks: [
        {
          kind: "maturity",
          name: next.name,
          date: next.maturityDate.toISOString().slice(0, 10),
          amount: koboToNaira(next.principalKobo),
          rate: `${next.rateBps / 100}% p.a.`,
          daysLeft: Math.max(
            0,
            Math.ceil((next.maturityDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
          ),
          expectedPayout: koboToNaira(next.principalKobo + next.accruedKobo),
        },
        { kind: "handoff", label: "View holding", to: `/portfolio/${next.id}` },
      ],
    };
  }

  if (/(fund|add money|top up|top-up)/.test(text)) {
    return {
      mode: "rules",
      text: "You can fund your Kipit wallet by bank transfer or card.",
      blocks: [{ kind: "handoff", label: "Add Money", to: "/wallet/add-money" }],
    };
  }

  if (/(withdraw|withdrawal)/.test(text)) {
    return {
      mode: "rules",
      text: "Withdrawals need Tier 2 verification and go through a secure review flow.",
      blocks: [{ kind: "handoff", label: "Continue Securely", to: "/withdraw" }],
    };
  }

  if (/(invest|plan|product|rate)/.test(text)) {
    const products = await prisma.product.findMany({
      where: { availability: "OPEN" },
      take: 3,
    });
    const bands = await prisma.rateBand.findMany({ orderBy: { minDays: "asc" }, take: 3 });
    return {
      mode: "rules",
      text: "Here are options that fit. Rate, tenor and minimum are shown together. Money moves only after you continue securely.",
      blocks: [
        {
          kind: "products",
          products: [
            ...bands
              .filter((b) => b.code !== "CALL")
              .slice(0, 2)
              .map((b) => ({
                name: b.label,
                rate: `${b.rateBps / 100}% p.a.`,
                tenor: b.maxDays ? `${b.minDays}-${b.maxDays} days` : `${b.minDays}+ days`,
                minimum: 10000,
                to: "/fixed-plans/create",
              })),
            ...products.map((p) => ({
              name: p.name,
              rate: `${p.rateBps / 100}% p.a.`,
              tenor: `${p.tenorDays} days`,
              minimum: koboToNaira(p.minimumKobo),
              to: `/explore/${p.id}/subscribe`,
            })),
          ],
        },
        { kind: "handoff", label: "Continue Securely", to: "/invest" },
      ],
    };
  }

  if (/(track|transaction|status|deposit)/.test(text)) {
    return {
      mode: "rules",
      text: "Here is where to track recent money movements.",
      blocks: [{ kind: "handoff", label: "View transactions", to: "/portfolio/transactions" }],
    };
  }

  if (/(help|support|ticket|faq)/.test(text)) {
    return {
      mode: "rules",
      text: "I can help file a support ticket or show ones you've already submitted. Money never moves in chat.",
      blocks: [
        { kind: "chips", options: ["I need to submit a support ticket", "Show my support tickets", "What's my balance?"] },
        { kind: "handoff", label: "Help centre", to: "/settings/help" },
        { kind: "handoff", label: "My tickets", to: "/settings/help/tickets" },
      ],
    };
  }

  return {
    mode: "rules",
    text: "I can help with your Kipit account, investments, transactions, support tickets and available products. I never move money in chat — you confirm with your PIN on the secure screen.",
    blocks: [
      { kind: "chips", options: ["What's my balance?", "Help me invest", "I need support"] },
    ],
  };
}

async function buildLlmReply(userId: string, sessionId: string, userText: string): Promise<AskAiReply> {
  const history = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  history.reverse();

  const messages: ChatMsg[] = [{ role: "system", content: SYSTEM_PROMPT }];

  for (const m of history) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (!m.content?.trim()) continue;
    messages.push({
      role: m.role as "user" | "assistant",
      content: m.content,
    });
  }

  // Keep last 12 turns (+ system)
  if (messages.length > 13) {
    messages.splice(1, messages.length - 13);
  }

  // History already includes the latest user message persisted by the route.
  if (messages[messages.length - 1]?.role !== "user") {
    messages.push({ role: "user", content: userText });
  }

  const blocks: ChatUiBlock[] = [];
  let rounds = 0;

  while (rounds < 4) {
    rounds++;
    const assistant = await chatCompletions(messages);

    if (assistant.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: assistant.content || "",
        tool_calls: assistant.tool_calls,
      });

      for (const call of assistant.tool_calls) {
        const result = await runTool(userId, call.function.name, call.function.arguments || "{}", blocks);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    const text = (assistant.content || "").trim();
    if (!text && blocks.length === 0) {
      return buildRuleBasedReply(userId, userText);
    }

    // Deduplicate handoff/chips kinds lightly
    const seen = new Set<string>();
    const uniqueBlocks = blocks.filter((b) => {
      const key = `${b.kind}:${JSON.stringify(b)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      mode: "llm",
      text:
        text ||
        "Here’s what I found. Money only moves after you continue securely with your PIN.",
      blocks: uniqueBlocks,
    };
  }

  // Tool-loop safety: fall back to rules
  return buildRuleBasedReply(userId, userText);
}

/** Main Ask AI entry — LLM when configured, otherwise rule intents. */
export async function buildAssistantReply(
  userId: string,
  sessionId: string,
  userText: string,
): Promise<AskAiReply> {
  if (!askAiLlmEnabled()) {
    return buildRuleBasedReply(userId, userText);
  }

  try {
    return await buildLlmReply(userId, sessionId, userText);
  } catch (err) {
    console.error("[ask-ai] LLM failed, falling back to rules", err);
    const fallback = await buildRuleBasedReply(userId, userText);
    return {
      ...fallback,
      text: `${fallback.text}`,
    };
  }
}
