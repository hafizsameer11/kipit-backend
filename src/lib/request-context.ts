import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";

type RequestMeta = {
  ip?: string;
  userAgent?: string;
};

export const requestContext = new AsyncLocalStorage<RequestMeta>();

export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  requestContext.run(
    {
      ip: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
    },
    next,
  );
}

export function getRequestMeta(): RequestMeta {
  return requestContext.getStore() ?? {};
}
