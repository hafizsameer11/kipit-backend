/**
 * B8 — credit Flex break payouts once breakCreditAt has passed.
 * Principal + 50% of accrued net interest → wallet; mark placement CLOSED.
 */
import { prisma } from "../lib/prisma.js";
import { koboToNaira } from "../lib/crypto.js";
import {
  accruedInterestToDateKobo,
  ensureUserWallet,
} from "../services/money.js";
import { ensureSystemAccount, postJournal } from "../services/ledger.js";
import { interestBreakdownFromNetAmount } from "../services/wht.js";
import { createUserNotification } from "../services/notify.js";

export async function runFlexBreakCredits() {
  const due = await prisma.placement.findMany({
    where: {
      status: "ACTIVE",
      planType: "FLEX",
      breakRequestedAt: { not: null },
      breakCreditAt: { lte: new Date() },
    },
    take: 50,
  });

  let credited = 0;
  for (const placement of due) {
    if (!placement.ledgerAccountId) continue;

    const accruedNet = accruedInterestToDateKobo(placement);
    const creditedNet = accruedNet / 2n;
    const creditAmount = placement.principalKobo + creditedNet;
    const bd = interestBreakdownFromNetAmount(creditedNet, placement.rateBps);
    const wallet = await ensureUserWallet(placement.userId);
    const interestExpense = await ensureSystemAccount("SYSTEM_INTEREST");

    await postJournal({
      kind: "MATURITY",
      idempotencyKey: `flex-break-${placement.id}`,
      description: `Flex break · ${placement.name}`,
      metadata: {
        placementId: placement.id,
        principalKobo: placement.principalKobo.toString(),
        creditedInterestNet: creditedNet.toString(),
        forfeitedNet: (accruedNet - creditedNet).toString(),
        grossKobo: bd.grossKobo.toString(),
        whtKobo: bd.whtKobo.toString(),
      },
      lines: [
        { accountId: wallet.id, amountKobo: creditAmount },
        { accountId: placement.ledgerAccountId, amountKobo: -placement.principalKobo },
        { accountId: interestExpense.id, amountKobo: -creditedNet },
      ],
    });

    await prisma.placement.update({
      where: { id: placement.id },
      data: { status: "CLOSED", accruedKobo: creditedNet },
    });

    await createUserNotification({
      userId: placement.userId,
      title: "Flex break credited",
      body: `₦${koboToNaira(creditAmount).toLocaleString("en-NG")} is now in your wallet (50% of accrued interest forfeited).`,
      href: "/wallet",
      pushKind: "investment",
      emailKind: "investment",
      amountNaira: koboToNaira(creditAmount),
      emailDetail: `Flex break credit · ${placement.name}`,
    }).catch(() => undefined);

    credited += 1;
  }

  return { scanned: due.length, credited };
}
