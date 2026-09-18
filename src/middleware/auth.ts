import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { verifyAccessToken } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";

export type AuthRequest = Request & {
  userId?: string;
  sessionId?: string;
};

export async function requireAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new AppError(401, "Missing access token", "UNAUTHORIZED");
    }
    const token = header.slice("Bearer ".length);
    const claims = verifyAccessToken(token);

    const session = await prisma.session.findFirst({
      where: { id: claims.sid, userId: claims.sub, revokedAt: null },
    });
    if (!session) throw new AppError(401, "Session revoked", "SESSION_REVOKED");

    await prisma.session.update({
      where: { id: session.id },
      data: { lastActiveAt: new Date() },
    });

    req.userId = claims.sub;
    req.sessionId = claims.sid;
    next();
  } catch (err) {
    if (err instanceof AppError) return next(err);
    return next(new AppError(401, "Invalid access token", "UNAUTHORIZED"));
  }
}
