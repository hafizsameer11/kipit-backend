import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import {
  confirmBvnMatch,
  getKycStatus,
  submitBvn,
  submitTier2,
} from "../services/kyc.js";

export const kycRouter = Router();

kycRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json({ data: await getKycStatus(req.userId!) });
  }),
);

kycRouter.post(
  "/bvn",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z.object({ bvn: z.string().length(11) }).parse(req.body);
    const result = await submitBvn(req.userId!, body.bvn);
    res.json({ data: result });
  }),
);

kycRouter.post(
  "/bvn/confirm",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json({ data: await confirmBvnMatch(req.userId!) });
  }),
);

kycRouter.post(
  "/tier2",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        nin: z.string().length(11),
        occupation: z.string().min(1),
        employmentStatus: z.string().min(1),
        sourceOfFunds: z.string().min(1),
        addressStreet: z.string().min(1),
        addressCity: z.string().min(1),
        addressState: z.string().min(1),
        addressLga: z.string().min(1),
        selfieUri: z.string().min(1),
        addressDocUri: z.string().min(1),
      })
      .parse(req.body);
    res.json({ data: await submitTier2({ userId: req.userId!, ...body }) });
  }),
);
