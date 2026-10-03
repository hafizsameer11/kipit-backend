import { z } from "zod";
import type { Prisma } from "@prisma/client";

export const productDetailsSchema = z
  .object({
    about: z.string().optional(),
    how: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
    documents: z
      .array(
        z.object({
          name: z.string().min(1),
          meta: z.string().optional().default(""),
          // Reject huge data: URLs — files must be uploaded via /v1/admin/products/attachments.
          url: z
            .string()
            .max(500)
            .optional()
            .default("")
            .refine((v) => !v || !/^data:/i.test(v), {
              message: "Upload the file instead of pasting base64",
            }),
        }),
      )
      .optional(),
    faqs: z
      .array(
        z.object({
          q: z.string().min(1),
          a: z.string().min(1),
        }),
      )
      .optional(),
    highlights: z
      .array(
        z.object({
          label: z.string().min(1),
          value: z.string().min(1),
        }),
      )
      .optional(),
  })
  .optional();

export type ProductDetails = z.infer<typeof productDetailsSchema>;

export function asProductDetails(value: unknown): ProductDetails | null {
  if (!value || typeof value !== "object") return null;
  const parsed = productDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data ?? null : null;
}

export function toPrismaJson(value: ProductDetails | null | undefined): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  if (value == null) return {};
  return value as Prisma.InputJsonValue;
}
