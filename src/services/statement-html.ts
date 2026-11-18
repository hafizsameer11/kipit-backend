/**
 * Appendix C / Statement_template.pdf — print HTML for Puppeteer PDF.
 * Uses embedded TeX Gyre Pagella + brand assets (same family as the official template).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAVY = "#001657";
const NAVY_SOFT = "#1a2f6b";
const GOLD = "#F5B400";
const GOLD_SOFT = "#FFF4CC";
const INK = "#0f172a";
const MUTED = "#5b6b8c";
const LINE = "#d7deeb";
const ROW_ALT = "#f5f7fb";

const FONT =
  "'TeXGyrePagella','Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif";

const AUTO_NOTE =
  "This is an automatically generated statement. It was produced by the Kipit platform from your account records on the date and time shown above. Please verify any figures with us if you have questions.";

const INTEREST_NOTE =
  "Accrued interest is the interest earned on your plans so far, calculated daily from the start date. Expected interest is the full interest payable if each plan is held to maturity. Withholding tax of 10% is deducted from all interest earned and remitted to the tax authority; value at maturity is your principal plus net interest. Kipit Lock plans cannot be broken before maturity. A Kipit Flex plan broken after 30 days attracts the loss of 50% of the interest accrued, in line with the terms you accepted.";

const RMB_DISCLAIMER =
  "Disclaimer: Investments shown are managed by Kipit Asset Management Limited (formerly Fortuna Capital Limited), a Fund/Portfolio Manager licensed by the Securities and Exchange Commission (SEC), Nigeria. All client funds, including wallet and Call Account balances, are held and administered by Rand Merchant Bank, our custodian. This statement is confidential and intended solely for the named client. If you notice any error, please contact us within 14 days of the statement date.";

const FOOTER_CONTACT =
  "Kipit Asset Management Limited | RC 8735505 | 7/9 Molade Okoya-Thomas Street, Victoria Island, Lagos | support@mykipit.com | +234 707 198 5171";

export type StatementPdfDoc = {
  title: string;
  subtitle?: string;
  reference?: string;
  rows?: { label: string; value: string }[];
  clientMeta?: { label: string; value: string }[];
  portfolioSummary?: { label: string; value: string }[];
  whtSection?: { label: string; gross: string; wht: string; net: string }[];
  investments?: {
    plan: string;
    principal: string;
    rate: string;
    maturity: string;
    gross: string;
    wht: string;
    net: string;
    valueAtMaturity: string;
  }[];
  transactions?: {
    date: string;
    description: string;
    reference: string;
    credit: string;
    debit: string;
  }[];
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function assetsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../assets/statement");
}

function dataUrl(fileName: string, mime: string) {
  const full = path.join(assetsDir(), fileName);
  const buf = fs.readFileSync(full);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function parsePeriodSubtitle(subtitle?: string) {
  if (!subtitle) return { period: "", ref: "" };
  const refMatch = subtitle.match(/Ref:\s*(.+)$/i);
  const period = subtitle
    .replace(/\s*·\s*Ref:.*/i, "")
    .replace(/^Statement period:\s*/i, "")
    .trim();
  return { period, ref: refMatch?.[1]?.trim() || "" };
}

function planParts(plan: string) {
  const [main, started] = plan.split(/\s·\sStarted\s/i);
  return {
    main: (main || plan).trim(),
    started: started ? `Started ${started.trim()}` : "",
  };
}

function sumMoneyColumn(rows: Record<string, string>[], key: string) {
  const total = rows.reduce((s, r) => {
    const n = Number(String(r[key] ?? "").replace(/[^\d.-]/g, ""));
    return s + (Number.isFinite(n) ? n : 0);
  }, 0);
  return `₦${total.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Print-ready HTML matching Statement_template.pdf / Appendix C. */
export function buildStatementHtml(input: StatementPdfDoc): string {
  const logo = dataUrl("logo.png", "image/png");
  const stamp = dataUrl("stamp.png", "image/png");
  const regular = dataUrl("pagella-regular.otf", "font/otf");
  const bold = dataUrl("pagella-bold.otf", "font/otf");
  const italic = dataUrl("pagella-italic.otf", "font/otf");

  const { period, ref } = parsePeriodSubtitle(input.subtitle);
  const reference = input.reference || ref;
  const periodLine = period
    ? `Statement period: ${period}`
    : input.subtitle
      ? input.subtitle
      : "";

  const clientMeta = (input.clientMeta ?? []).slice(0, 4);
  const clientMetaHtml = clientMeta.length
    ? `<div class="gold-rule" aria-hidden="true"></div>
       <div class="meta">${clientMeta
         .map(
           (c) => `<div class="meta-cell">
            <div class="meta-label">${escapeHtml(c.label)}</div>
            <div class="meta-value">${escapeHtml(c.value)}</div>
          </div>`,
         )
         .join("")}</div>`
    : "";

  const portfolio = input.portfolioSummary ?? [];
  const portfolioHtml = portfolio.length
    ? `<h2>Portfolio summary</h2>
       <div class="summary-grid">${portfolio
         .map((r) => {
           const emphasize = /total portfolio value today/i.test(r.label);
           const accent =
             /net interest accrued/i.test(r.label) ||
             /value at maturity/i.test(r.label);
           const cls = [
             "summary-card",
             emphasize ? "summary-card--emphasis" : "",
             accent && !emphasize ? "summary-card--accent" : "",
           ]
             .filter(Boolean)
             .join(" ");
           return `<div class="${cls}">
             <div class="summary-label">${escapeHtml(r.label)}</div>
             <div class="summary-value">${escapeHtml(r.value)}</div>
           </div>`;
         })
         .join("")}</div>`
    : "";

  const whtHtml = (input.whtSection ?? [])
    .map(
      (r, i) => `<tr class="${i % 2 ? "alt" : ""}">
        <td>${escapeHtml(r.label)}</td>
        <td class="num">${escapeHtml(r.gross)}</td>
        <td class="num">${escapeHtml(r.wht)}</td>
        <td class="num strong">${escapeHtml(r.net)}</td>
      </tr>`,
    )
    .join("");

  const investments = input.investments ?? [];
  let invBody = investments
    .map((r, i) => {
      const { main, started } = planParts(r.plan);
      return `<tr class="${i % 2 ? "alt" : ""}">
        <td><div class="strong">${escapeHtml(main)}</div>${
          started ? `<div class="muted small">${escapeHtml(started)}</div>` : ""
        }</td>
        <td class="num">${escapeHtml(r.principal)}</td>
        <td class="num">${escapeHtml(r.rate)}</td>
        <td class="num">${escapeHtml(r.maturity)}</td>
        <td class="num">${escapeHtml(r.gross)}</td>
        <td class="num">${escapeHtml(r.wht)}</td>
        <td class="num">${escapeHtml(r.net)}</td>
        <td class="num strong">${escapeHtml(r.valueAtMaturity)}</td>
      </tr>`;
    })
    .join("");
  if (investments.length) {
    invBody += `<tr class="total">
      <td class="strong">TOTAL</td>
      <td class="num strong">${sumMoneyColumn(investments, "principal")}</td>
      <td></td><td></td>
      <td class="num strong">${sumMoneyColumn(investments, "gross")}</td>
      <td class="num strong">${sumMoneyColumn(investments, "wht")}</td>
      <td class="num strong">${sumMoneyColumn(investments, "net")}</td>
      <td class="num strong">${sumMoneyColumn(investments, "valueAtMaturity")}</td>
    </tr>`;
  }

  const txnHtml = (input.transactions ?? [])
    .map(
      (r, i) => `<tr class="${i % 2 ? "alt" : ""}">
        <td class="nowrap">${escapeHtml(r.date)}</td>
        <td>${escapeHtml(r.description)}</td>
        <td class="muted small">${escapeHtml(r.reference)}</td>
        <td class="num">${escapeHtml(r.credit)}</td>
        <td class="num">${escapeHtml(r.debit)}</td>
      </tr>`,
    )
    .join("");

  const rowsHtml = (input.rows ?? [])
    .map(
      (r, i) => `<tr class="${i % 2 ? "alt" : ""}">
        <td class="muted">${escapeHtml(r.label)}</td>
        <td class="num strong">${escapeHtml(r.value)}</td>
      </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(input.title)}</title>
<style>
@font-face{font-family:'TeXGyrePagella';src:url('${regular}') format('opentype');font-weight:400;font-style:normal}
@font-face{font-family:'TeXGyrePagella';src:url('${bold}') format('opentype');font-weight:700;font-style:normal}
@font-face{font-family:'TeXGyrePagella';src:url('${italic}') format('opentype');font-weight:400;font-style:italic}
*{box-sizing:border-box;font-family:${FONT} !important}
html,body{margin:0;padding:0;background:#fff;color:${NAVY};font-family:${FONT}}
@page{size:A4;margin:12mm 11mm}
body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{width:100%;max-width:186mm;margin:0 auto;padding:0;font-size:10.5pt;line-height:1.4;color:${NAVY}}
header{display:flex;align-items:stretch;justify-content:space-between;gap:16px;margin:0 0 0}
.logo{height:56px;width:auto;max-width:280px;object-fit:contain}
.title-box{background:${NAVY};color:#fff;min-width:46%;max-width:52%;padding:16px 18px;display:flex;flex-direction:column;justify-content:center}
.title-box .title{font-size:14pt;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;line-height:1.15}
.title-box .sub{margin-top:8px;font-size:9.5pt;line-height:1.45;color:rgba(255,255,255,0.92);font-weight:400}
/* Template: gold strip under logo/title, then light-gray client bar (not a full gold block). */
.gold-rule{height:10px;background:${GOLD};margin:14px 0 0;width:100%}
.meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;background:#eef1f6;padding:12px 14px;margin:0 0 16px;border:none}
.meta-label{font-size:8.5pt;letter-spacing:0;text-transform:none;color:#6b7280;font-weight:400}
.meta-value{margin-top:4px;font-size:11.5pt;font-weight:700;color:${NAVY}}
h2{margin:18px 0 9px;font-size:10pt;letter-spacing:0.12em;text-transform:uppercase;color:${NAVY};font-weight:700}
.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
.summary-card{border:1px solid #cfd6e4;background:#fff;padding:11px 12px 13px;min-height:72px}
.summary-card--accent{border-left:5px solid ${GOLD}}
.summary-card--emphasis{background:${NAVY};border-color:${NAVY}}
.summary-label{font-size:8.5pt;line-height:1.35;color:#6b7280;font-weight:400}
.summary-card--emphasis .summary-label{color:rgba(255,255,255,0.8)}
.summary-value{margin-top:9px;font-size:15pt;line-height:1.12;font-weight:700;color:${NAVY};font-variant-numeric:tabular-nums}
.summary-card--emphasis .summary-value{color:#fff}
table{width:100%;border-collapse:collapse;table-layout:auto}
th{padding:8px 7px;background:${NAVY};color:#fff;font-size:8pt;text-transform:none;letter-spacing:0.02em;font-weight:700;text-align:left;border:none}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
td{padding:7px 6px;border-bottom:1px solid ${LINE};font-size:9.5pt;vertical-align:top;color:${NAVY}}
tr.alt td{background:${ROW_ALT}}
tr.total td{background:${NAVY};color:#fff;border:none}
.strong{font-weight:700}
.muted{color:#6b7280}
.small{font-size:8pt;margin-top:2px}
.nowrap{white-space:nowrap}
.note{margin-top:16px;background:${GOLD_SOFT};border:1px solid ${GOLD};padding:10px 12px;font-size:9pt;line-height:1.5;color:${NAVY_SOFT}}
.footer-row{margin-top:14px;display:flex;align-items:flex-end;justify-content:space-between;gap:16px}
.legal{flex:1;font-size:8pt;line-height:1.5;color:${NAVY}}
.stamp-wrap{text-align:center;flex-shrink:0;width:120px}
.stamp{width:100px;height:100px;object-fit:contain;display:block;margin:0 auto}
.stamp-caption{margin-top:5px;font-size:7.5pt;line-height:1.3;color:${NAVY};font-weight:700}
.contact{margin-top:14px;border-top:1px solid ${LINE};padding-top:8px;font-size:7.5pt;color:#6b7280}
</style>
</head>
<body>
  <div class="sheet">
    <header>
      <div><img class="logo" src="${logo}" alt="Kipit Asset Management"/></div>
      <div class="title-box">
        <div class="title">${escapeHtml(input.title)}</div>
        ${periodLine ? `<div class="sub">${escapeHtml(periodLine)}</div>` : ""}
        ${reference ? `<div class="sub">Ref: ${escapeHtml(reference)}</div>` : ""}
      </div>
    </header>

    ${clientMetaHtml}
    ${portfolioHtml}

    ${
      whtHtml
        ? `<h2>Interest and withholding tax</h2>
           <table>
             <thead><tr>
               <th>Source</th>
               <th class="num">Gross interest</th>
               <th class="num">Less withholding tax (10%)</th>
               <th class="num">Net interest</th>
             </tr></thead>
             <tbody>${whtHtml}</tbody>
           </table>`
        : ""
    }

    ${
      investments.length
        ? `<h2>Active investments</h2>
           <table>
             <thead><tr>
               <th>Plan</th>
               <th class="num">Principal</th>
               <th class="num">Rate p.a. net (gross)</th>
               <th class="num">Maturity date</th>
               <th class="num">Gross interest</th>
               <th class="num">WHT (10%)</th>
               <th class="num">Net interest</th>
               <th class="num">Value at maturity</th>
             </tr></thead>
             <tbody>${invBody}</tbody>
           </table>`
        : ""
    }

    ${
      txnHtml
        ? `<h2>Transactions in this period</h2>
           <table>
             <thead><tr>
               <th>Date</th>
               <th>Description</th>
               <th>Reference</th>
               <th class="num">Credit</th>
               <th class="num">Debit</th>
             </tr></thead>
             <tbody>${txnHtml}</tbody>
           </table>`
        : ""
    }

    ${
      rowsHtml && !portfolioHtml
        ? `<h2>Details</h2><table><tbody>${rowsHtml}</tbody></table>`
        : rowsHtml && portfolioHtml
          ? `<h2>Period movement</h2>
             <table>
               <thead><tr><th>Detail</th><th class="num">Value</th></tr></thead>
               <tbody>${rowsHtml}</tbody>
             </table>`
          : ""
    }

    <div class="note">${escapeHtml(AUTO_NOTE)}</div>

    <div class="footer-row">
      <div class="legal">
        <p style="margin:0 0 8px">${escapeHtml(INTEREST_NOTE)}</p>
        <p style="margin:0"><strong style="color:${NAVY}">${escapeHtml(RMB_DISCLAIMER)}</strong></p>
      </div>
      <div class="stamp-wrap">
        <img class="stamp" src="${stamp}" alt="Kipit company stamp"/>
        <div class="stamp-caption">Authorised by Kipit Asset Management Limited</div>
      </div>
    </div>

    <div class="contact">${escapeHtml(FOOTER_CONTACT)}</div>
  </div>
</body>
</html>`;
}
