import type { NextFunction, Request, Response } from "express";
import { assertNotInMaintenance } from "../services/app-access.js";

/** Block mutating customer money/product actions while maintenance mode is on. */
export function rejectIfMaintenance(req: Request, _res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  void assertNotInMaintenance()
    .then(() => next())
    .catch(next);
}
