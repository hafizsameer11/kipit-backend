import type { NextFunction, Response } from "express";
import { KycTier } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import type { AuthRequest } from "./auth.js";

const tierRank: Record<KycTier, number> = {
  TIER_0: 0,
  TIER_1: 1,
  TIER_2: 2,
};

export function requireKyc(min: KycTier) {
  return async (req: AuthRequest, _res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
      if (user.frozen) {
        const reason = user.frozenReason?.trim();
        throw new AppError(
          403,
          reason
            ? `Your account is temporarily restricted: ${reason}. Your money is safe. Contact Kipit support to lift the restriction.`
            : "Your account is temporarily restricted. Your money is safe. Contact Kipit support to lift the restriction.",
          "ACCOUNT_FROZEN",
        );
      }
      if (tierRank[user.kycTier] < tierRank[min]) {
        throw new AppError(403, `Requires ${min}`, "KYC_REQUIRED");
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
