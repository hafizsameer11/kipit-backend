/**
 * Server-side statement PDF via Chromium print (vector text, exact print CSS).
 * Matches Statement_template.pdf / Appendix C far better than html2canvas screenshots.
 */
import puppeteer, { type Browser } from "puppeteer";
import {
  buildStatementHtml,
  type StatementPdfDoc,
} from "./statement-html.js";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--font-render-hinting=none",
        ],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

export async function renderStatementPdf(doc: StatementPdfDoc): Promise<Buffer> {
  const html = buildStatementHtml(doc);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, {
      waitUntil: "load",
      timeout: 45_000,
    });
    // Ensure webfonts (data-URL Pagella) are applied before print.
    await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fonts = (document as any).fonts;
      if (fonts?.ready) await fonts.ready;
    });
    await new Promise((r) => setTimeout(r, 250));

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}
