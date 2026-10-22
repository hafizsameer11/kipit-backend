/**
 * Optional Sentry — observe-only. Never changes HTTP status, body, or request flow.
 * Missing DSN or init/capture failure → API behaves exactly as before.
 */
import * as Sentry from "@sentry/node";
import type { Request } from "express";
import { env } from "./env.js";

let enabled = false;

export function initSentry(): void {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) {
    console.log("[sentry] disabled (no SENTRY_DSN)");
    return;
  }

  try {
    Sentry.init({
      dsn,
      environment: env.NODE_ENV,
      release: "kipit-api@0.1.0",
      // Errors only — no tracing/instrumentation that wraps Express handlers.
      tracesSampleRate: 0,
      defaultIntegrations: false,
      integrations: [],
      beforeSend(event) {
        if (event.request?.headers) {
          const h = { ...event.request.headers };
          for (const key of Object.keys(h)) {
            const lower = key.toLowerCase();
            if (
              lower === "authorization" ||
              lower === "cookie" ||
              lower === "x-api-key" ||
              lower.includes("secret") ||
              lower.includes("password")
            ) {
              h[key] = "[Filtered]";
            }
          }
          event.request.headers = h;
        }
        if (event.request?.data && typeof event.request.data === "object") {
          event.request.data = scrubBody(event.request.data as Record<string, unknown>);
        }
        return event;
      },
    });
    enabled = true;
    console.log("[sentry] enabled");
  } catch (err) {
    enabled = false;
    console.warn("[sentry] init failed — continuing without Sentry", err);
  }
}

function scrubBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("password") ||
      lower.includes("pin") ||
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("otp") ||
      lower.includes("cvv")
    ) {
      out[key] = "[Filtered]";
    }
  }
  return out;
}

/** Report unexpected 500s only. Never throws; never delays the response. */
export function captureUnexpectedError(err: unknown, req?: Request): void {
  if (!enabled) return;
  try {
    Sentry.withScope((scope) => {
      if (req) {
        scope.setTag("method", req.method);
        scope.setTag(
          "route",
          req.route?.path ? String(req.route.path) : req.path,
        );
        scope.setContext("request", {
          method: req.method,
          path: req.originalUrl || req.url,
        });
      }
      scope.setLevel("error");
      Sentry.captureException(err);
    });
  } catch {
    /* never break the API */
  }
}

export function isSentryEnabled(): boolean {
  return enabled;
}
