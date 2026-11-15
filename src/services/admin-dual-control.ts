import { verifySecret } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import type { AdminRequest } from "../middleware/admin.js";
import { isPrivilegedAdminRole } from "./admin-permissions.js";

export type DualControlInput = {
  operatorPin?: string;
  approverEmail?: string;
  approverPin?: string;
};

export function dualControlFromBody(body: Record<string, unknown>): DualControlInput {
  return {
    operatorPin: typeof body.operatorPin === "string" ? body.operatorPin : undefined,
    approverEmail: typeof body.approverEmail === "string" ? body.approverEmail : undefined,
    approverPin: typeof body.approverPin === "string" ? body.approverPin : undefined,
  };
}

/** Second-person approval for non-privileged operators (e.g. Operations). */
export async function assertDualControlForMutation(
  req: AdminRequest,
  fields: DualControlInput,
): Promise<void> {
  if (isPrivilegedAdminRole(req.adminRole)) return;

  const actor = await prisma.adminUser.findUnique({ where: { id: req.adminId! } });
  if (!actor) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  if (!actor.pinHash || !fields.operatorPin) {
    throw new AppError(400, "Your console PIN is required for this change", "PIN_REQUIRED");
  }
  const selfOk = await verifySecret(fields.operatorPin, actor.pinHash);
  if (!selfOk) throw new AppError(401, "Incorrect operator PIN", "PIN_INVALID");

  if (!fields.approverEmail?.trim() || !fields.approverPin) {
    throw new AppError(
      400,
      "A second approver’s email and PIN are required",
      "APPROVER_REQUIRED",
    );
  }

  const approver = await prisma.adminUser.findFirst({
    where: { email: fields.approverEmail.toLowerCase().trim(), active: true },
  });
  if (!approver?.pinHash) {
    throw new AppError(400, "Approver not found or has no PIN set", "APPROVER_INVALID");
  }
  if (approver.id === actor.id) {
    throw new AppError(400, "Approver must be a different operator", "APPROVER_SELF");
  }
  const approverOk = await verifySecret(fields.approverPin, approver.pinHash);
  if (!approverOk) throw new AppError(401, "Incorrect approver PIN", "APPROVER_PIN_INVALID");

  const canApprove =
    approver.role === "SUPER" ||
    approver.role === "GLOBAL" ||
    approver.role === "FINANCE" ||
    (approver.makerChecker && approver.role !== "READ_ONLY");
  if (!canApprove) {
    throw new AppError(403, "That approver cannot sign off on this change", "APPROVER_FORBIDDEN");
  }
}