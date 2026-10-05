import { ensureRatesApplied } from "../services/rates.js";

/** Apply approved rate changes whose effective date has arrived; repair premature applies. */
export async function runApplyRateChangesJob() {
  return ensureRatesApplied();
}
