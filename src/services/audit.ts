import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getRequestMeta } from "../lib/request-context.js";

export async function writeAudit(input: {
  actorUserId?: string;
  actorAdminId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ipAddress?: string;
  userAgent?: string;
  /** When set, fills ipAddress/userAgent if those fields were omitted. */
  req?: { ip?: string; get?: (name: string) => string | undefined };
}) {
  const ctx = getRequestMeta();
  const ipAddress = input.ipAddress ?? input.req?.ip ?? ctx.ip;
  const userAgent =
    input.userAgent ?? input.req?.get?.("user-agent") ?? ctx.userAgent ?? undefined;
  return prisma.auditEvent.create({
    data: {
      actorUserId: input.actorUserId,
      actorAdminId: input.actorAdminId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before,
      after: input.after,
      ipAddress,
      userAgent,
    },
  });
}
