import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { asyncHandler } from "../lib/errors.js";
import type { AuthRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { buildAssistantReply } from "../services/ask-ai.js";

export const chatRouter = Router();

/**
 * Ask AI — LLM (OpenAI-compatible) when OPENAI_API_KEY is set; otherwise rule intents.
 * Tools load live balances/products; UI blocks + secure handoffs. Never moves money here.
 */
chatRouter.post(
  "/message",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const body = z
      .object({
        sessionId: z.string().optional(),
        text: z.string().min(1).max(2000),
      })
      .parse(req.body);

    const session =
      (body.sessionId
        ? await prisma.chatSession.findFirst({
            where: { id: body.sessionId, userId: req.userId! },
          })
        : null) ??
      (await prisma.chatSession.create({ data: { userId: req.userId! } }));

    await prisma.chatMessage.create({
      data: { sessionId: session.id, role: "user", content: body.text },
    });

    const reply = await buildAssistantReply(req.userId!, session.id, body.text);

    await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        role: "assistant",
        content: reply.text,
        blocks: reply.blocks as Prisma.InputJsonValue,
      },
    });

    res.json({
      data: {
        sessionId: session.id,
        mode: reply.mode,
        message: {
          role: "assistant",
          text: reply.text,
          blocks: reply.blocks,
        },
      },
    });
  }),
);
