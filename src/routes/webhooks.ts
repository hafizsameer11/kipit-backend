import { Router, raw, type Request, type Response, type NextFunction } from "express";
import { asyncHandler, AppError } from "../lib/errors.js";
import { verifyMonnifyWebhookSignature } from "../services/payments/monnify.js";
import { verifyPaystackWebhookSignature } from "../services/payments/paystack.js";
import { creditFromMonnifyWebhook, confirmCardPayment } from "../services/payments/funding.js";
import { nairaToKobo } from "../lib/crypto.js";
import { prisma } from "../lib/prisma.js";

export const webhooksRouter = Router();

/** Capture raw body for signature verification. */
export function rawJsonMiddleware(req: Request, res: Response, next: NextFunction) {
  raw({ type: "application/json" })(req, res, (err) => {
    if (err) return next(err);
    try {
      const buf = req.body as Buffer;
      (req as Request & { rawBody?: string }).rawBody = buf?.toString("utf8") ?? "";
      req.body = buf?.length ? JSON.parse((req as Request & { rawBody: string }).rawBody) : {};
    } catch {
      return next(new AppError(400, "Invalid JSON", "BAD_JSON"));
    }
    next();
  });
}

webhooksRouter.post(
  "/monnify",
  asyncHandler(async (req, res) => {
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const signature =
      (req.headers["monnify-signature"] as string | undefined) ??
      (req.headers["x-monnify-signature"] as string | undefined);
    if (!verifyMonnifyWebhookSignature(rawBody, signature)) {
      throw new AppError(401, "Invalid Monnify signature", "WEBHOOK_SIGNATURE");
    }

    const event = req.body as {
      eventType?: string;
      eventData?: {
        product?: { type?: string };
        destinationAccountInformation?: { accountNumber?: string };
        amountPaid?: number;
        settlementAmount?: number;
        transactionReference?: string;
        paymentReference?: string;
        customerName?: string;
      };
    };

    const data = event.eventData;
    if (!data?.destinationAccountInformation?.accountNumber) {
      return res.json({ ok: true, ignored: true });
    }

    const amountNaira = data.amountPaid ?? data.settlementAmount ?? 0;
    const reference =
      data.transactionReference ?? data.paymentReference ?? `monnify-${Date.now()}`;

    await creditFromMonnifyWebhook({
      accountNumber: data.destinationAccountInformation.accountNumber,
      amountKobo: Number(nairaToKobo(amountNaira)),
      transactionReference: reference,
      payerAccountName: data.customerName,
    });

    res.json({ ok: true });
  }),
);

webhooksRouter.post(
  "/paystack",
  asyncHandler(async (req, res) => {
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const signature = req.headers["x-paystack-signature"] as string | undefined;
    if (!verifyPaystackWebhookSignature(rawBody, signature)) {
      throw new AppError(401, "Invalid Paystack signature", "WEBHOOK_SIGNATURE");
    }

    const event = req.body as {
      event?: string;
      data?: { reference?: string; metadata?: { userId?: string }; status?: string };
    };

    if (event.event === "charge.success" && event.data?.reference) {
      const intent = await prisma.paymentIntent.findUnique({
        where: { reference: event.data.reference },
      });
      if (intent) {
        await confirmCardPayment({ userId: intent.userId, reference: intent.reference });
      }
    }

    res.json({ ok: true });
  }),
);
