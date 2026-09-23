import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../lib/errors.js";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";

export type AdminRoleName = "SUPER" | "GLOBAL" | "COMPLIANCE" | "OPERATIONS" | "MARKETING";

export type AdminRequest = Request & {
  adminId?: string;
  adminRole?: AdminRoleName;
  adminName?: string;
  adminEmail?: string;
};

/** Roles allowed to see total funds under management / AUM. */
export const AUM_ROLES: AdminRoleName[] = ["SUPER", "GLOBAL", "OPERATIONS"];

export function canViewAum(role?: string | null) {
  return Boolean(role && AUM_ROLES.includes(role as AdminRoleName));
}

export async function requireAdmin(req: AdminRequest, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const token = header.slice(7);
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as {
      sub: string;
      sid?: string;
      typ?: string;
      role?: string;
    };
    if (payload.typ !== "admin") throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const admin = await prisma.adminUser.findFirst({
      where: { id: payload.sub, active: true },
    });
    if (!admin) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    if (payload.sid) {
      const session = await prisma.adminSession.findFirst({
        where: { id: payload.sid, adminId: admin.id, revokedAt: null },
      });
      if (!session) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    req.adminId = admin.id;
    req.adminRole = admin.role as AdminRoleName;
    req.adminName = admin.name;
    req.adminEmail = admin.email;
    next();
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(401, "Unauthorized", "UNAUTHORIZED"));
  }
}

export function requireRoles(...roles: AdminRoleName[]) {
  return (req: AdminRequest, _res: Response, next: NextFunction) => {
    if (!req.adminId) {
      next(new AppError(401, "Unauthorized", "UNAUTHORIZED"));
      return;
    }
    if (!req.adminRole || !roles.includes(req.adminRole)) {
      next(new AppError(403, "Insufficient permissions", "FORBIDDEN"));
      return;
    }
    next();
  };
}
