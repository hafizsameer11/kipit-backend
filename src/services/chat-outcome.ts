/** Classify Ask AI sessions from stored messages + UI blocks (not keyword guesses). */

export type ChatOutcomeKind = "resolved" | "handoff" | "abandoned" | "escalated";

export type ChatOutcomeMessage = {
  role?: string;
  content?: string | null;
  blocks?: unknown;
};

export type ChatHandoff = { label: string; to: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function extractChatHandoffs(messages: ChatOutcomeMessage[]): ChatHandoff[] {
  const out: ChatHandoff[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.blocks)) continue;
    for (const raw of m.blocks) {
      const b = asRecord(raw);
      if (!b || String(b.kind) !== "handoff") continue;
      const to = typeof b.to === "string" ? b.to : "";
      if (!to) continue;
      out.push({
        label: typeof b.label === "string" && b.label.trim() ? b.label.trim() : "Continue",
        to,
      });
    }
  }
  return out;
}

export function isSupportHandoffPath(to: string): boolean {
  return /\/settings\/help|ticket/i.test(to);
}

export function handoffDestinationLabel(to: string, label?: string): string {
  if (isSupportHandoffPath(to)) return "Support ticket";
  if (/withdraw/i.test(to)) return "Withdrawal request";
  if (/add-money|fund|wallet/i.test(to)) return "Add money / funding";
  if (/invest/i.test(to)) return "Fixed plan setup";
  if (/explore/i.test(to)) return "Explore product detail";
  if (/portfolio\/transactions|activity/i.test(to)) return "Transaction activity";
  if (/portfolio/i.test(to)) return "Portfolio";
  if (/verification|kyc/i.test(to)) return "Verification";
  return label?.trim() || "Secure journey";
}

export function classifyChatSessionOutcome(input: {
  messageCount: number;
  flagged?: boolean;
  messages: ChatOutcomeMessage[];
}): { outcome: ChatOutcomeKind; handoffTo: string | null; handoffs: ChatHandoff[] } {
  const handoffs = extractChatHandoffs(input.messages);
  const support = handoffs.find((h) => isSupportHandoffPath(h.to));
  const journey = handoffs.find((h) => !isSupportHandoffPath(h.to));

  const joined = input.messages.map((m) => m.content || "").join(" ").toLowerCase();
  const textEscalated =
    /support ticket (received|opened|logged|created)|i'?ve (filed|opened|created|logged) a (support )?ticket|we'?ve logged [“"]/.test(
      joined,
    );

  if (support || textEscalated || input.flagged) {
    return {
      outcome: "escalated",
      handoffTo: support ? handoffDestinationLabel(support.to, support.label) : "Support ticket",
      handoffs,
    };
  }

  if (journey) {
    return {
      outcome: "handoff",
      handoffTo: handoffDestinationLabel(journey.to, journey.label),
      handoffs,
    };
  }

  if (input.messageCount <= 2) {
    return { outcome: "abandoned", handoffTo: null, handoffs };
  }

  return { outcome: "resolved", handoffTo: null, handoffs };
}
