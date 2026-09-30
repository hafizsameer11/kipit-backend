import { Router } from "express";
import { asyncHandler } from "../lib/errors.js";
import { getPublicAppConfig } from "./admin-console.js";

/** Unauthenticated app bootstrap config (support contacts, maintenance). */
export const appConfigRouter = Router();

appConfigRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const data = await getPublicAppConfig();
    res.json({ data });
  }),
);
