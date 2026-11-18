import fs from "node:fs";
import { renderStatementPdf } from "../src/services/statement-pdf.js";

async function main() {
  const buf = await renderStatementPdf({
    title: "Investment statement",
    subtitle: "Statement period: 20 Aug 2026 to 18 Nov 2026",
    reference: "KAM-STMT-TEST",
    clientMeta: [
      { label: "Client name", value: "Christopher Sangodiji" },
      { label: "Client ID", value: "KAM-QNKZNW" },
      { label: "Statement date", value: "18 Nov 2026" },
      { label: "Time generated", value: "20:30" },
    ],
    portfolioSummary: [
      { label: "Wallet balance", value: "₦4,078.44" },
      { label: "Call Account balance (incl. net interest)", value: "₦1,008.15" },
      { label: "Fixed plans (principal)", value: "₦5,039.72" },
      { label: "Net interest accrued to date", value: "₦0.36" },
      { label: "Total portfolio value today", value: "₦10,126.67" },
      { label: "Fixed plans value at maturity", value: "₦5,132.24" },
    ],
    whtSection: [
      {
        label: "Fixed plans: interest accrued to date",
        gross: "₦0.40",
        wht: "₦0.04",
        net: "₦0.36",
      },
      {
        label: "Fixed plans: expected interest at maturity",
        gross: "₦102.80",
        wht: "₦10.28",
        net: "₦92.52",
      },
      {
        label: "Call Account: interest accrued to date",
        gross: "₦0.00",
        wht: "₦0.00",
        net: "₦0.00",
      },
    ],
    investments: [
      {
        plan: "Kipit Lock, 180 days · Started 15 Sep 2026",
        principal: "₦5,039.72",
        rate: "16.20% (18.00%)",
        maturity: "14 Mar 2027",
        gross: "₦102.80",
        wht: "₦10.28",
        net: "₦92.52",
        valueAtMaturity: "₦5,132.24",
      },
    ],
  });
  fs.mkdirSync("assets/statement", { recursive: true });
  fs.writeFileSync("assets/statement/_smoke.pdf", buf);
  console.log("pdf bytes", buf.length, "header", buf.subarray(0, 5).toString());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
