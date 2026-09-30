/**
 * Daily portfolio digest — invoke via POST /v1/admin/marketing/digest/send-now
 * or wire to cron (e.g. 07:30 Africa/Lagos) when scheduler is available.
 */
import { prisma } from "../lib/prisma.js";

export async function runMarketingDigestJob(input?: { manual?: boolean; adminId?: string }) {
  const userCount = await prisma.user.count({ where: { frozen: false } });
  const job = await prisma.jobRun.create({
    data: {
      jobName: "marketing.digest",
      status: "SUCCESS",
      detail: {
        manual: Boolean(input?.manual),
        requestedBy: input?.adminId ?? null,
        recipientCount: userCount,
        note: "Digest delivery stub — connect email/push batch sender here.",
      },
      finishedAt: new Date(),
    },
  });
  return {
    jobId: job.id,
    recipientCount: userCount,
    sentAt: new Date().toISOString(),
  };
}
