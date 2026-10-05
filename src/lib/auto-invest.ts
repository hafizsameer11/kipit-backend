export const AUTO_INVEST_FREQUENCIES = [
  "Every 10 minutes",
  "Every hour",
  "Weekly",
  "Every 2 weeks",
  "Monthly",
] as const;

export type AutoInvestFrequency = (typeof AUTO_INVEST_FREQUENCIES)[number];

const FREQ_SET = new Set<string>(AUTO_INVEST_FREQUENCIES);

export function isAutoInvestFrequency(value: string): value is AutoInvestFrequency {
  return FREQ_SET.has(value);
}

export function parseFrequencyFromLabel(label: string): AutoInvestFrequency | null {
  const freqMatch = label.match(
    /^(Every 10 minutes|Every hour|Weekly|Every 2 weeks|Monthly)\s*·\s*(.*)$/,
  );
  return freqMatch ? (freqMatch[1] as AutoInvestFrequency) : null;
}

export function stripFrequencyPrefix(label: string): string {
  const freqMatch = label.match(
    /^(Every 10 minutes|Every hour|Weekly|Every 2 weeks|Monthly)\s*·\s*(.*)$/,
  );
  return freqMatch ? freqMatch[2]! : label;
}

export function intervalMs(frequency: AutoInvestFrequency): number | null {
  if (frequency === "Every 10 minutes") return 10 * 60 * 1000;
  if (frequency === "Every hour") return 60 * 60 * 1000;
  if (frequency === "Weekly") return 7 * 24 * 60 * 60 * 1000;
  if (frequency === "Every 2 weeks") return 14 * 24 * 60 * 60 * 1000;
  return null; // Monthly uses calendar day
}

/** Next run instant from a reference time. */
export function nextAutoInvestRunAt(
  frequency: AutoInvestFrequency,
  dayOfMonth: number,
  from: Date = new Date(),
): Date {
  const day = Math.min(Math.max(dayOfMonth, 1), 28);
  const ms = intervalMs(frequency);
  if (ms != null) {
    return new Date(from.getTime() + ms);
  }
  // Monthly — next calendar occurrence of dayOfMonth
  const candidate = new Date(from.getFullYear(), from.getMonth(), day, from.getHours(), from.getMinutes(), 0, 0);
  if (candidate.getTime() <= from.getTime()) {
    candidate.setMonth(candidate.getMonth() + 1);
  }
  return candidate;
}

/** Display helper (ISO date for calendar freqs; ISO datetime for short freqs). */
export function formatNextRun(frequency: AutoInvestFrequency, at: Date | null): string | null {
  if (!at) return null;
  if (frequency === "Every 10 minutes" || frequency === "Every hour") {
    return at.toISOString();
  }
  return at.toISOString().slice(0, 10);
}

export function resolveFrequency(
  stored: string,
  label: string,
): AutoInvestFrequency {
  if (isAutoInvestFrequency(stored)) return stored;
  return parseFrequencyFromLabel(label) ?? "Monthly";
}
