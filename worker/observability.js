// =====================================================
// OBSERVABILITY (v7I)
//
// Before this, an unhandled exception became a generic 500 with no trace anywhere. Now every response carries a request
// id (X-Request-Id; the same id is in audit rows), failures are logged as one structured JSON line each and recorded in
// request_errors (alerted on, shown on the staff Errors page), and slow requests are logged.
//
// What is never logged: query strings, headers, cookies, request or response bodies, user input. The route is the path
// with ids and tokens replaced by placeholders, so it is safe to keep and to group by.
// =====================================================
import * as errorsRepo from "./repositories/request-errors.js";
import { captureException, errorTrackingMode } from "./error-tracking.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** "/api/organizations/6f1e.../sites/42/dashboard-admin" -> "/api/organizations/:id/sites/:n/dashboard-admin" */
export function routeOf(pathname) {
  return String(pathname || "/")
    .replace(UUID, ":id")
    .split("/")
    .map((seg) => {
      if (/^\d+$/.test(seg)) return ":n";
      if (seg.length > 24 && /^[A-Za-z0-9_.~-]+$/.test(seg)) return ":token";   // keys, tokens, hashes
      return seg;
    })
    .join("/")
    .slice(0, 160);
}

export function slowThresholdMs(env) {
  const n = Number(env?.SLOW_REQUEST_MS);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

const line = (level, fields) => JSON.stringify({ level, ...fields });

/**
 * Called once per request with the finished response (or the exception that ended it). Never throws.
 * LOG_REQUESTS=all logs every request; the default logs failures and slow requests only (log volume is billed).
 */
export async function observe(env, ctx, { requestId, method, pathname, status, startedAt, error = null }) {
  try {
    const durationMs = Date.now() - startedAt;
    const route = routeOf(pathname);
    const failed = status >= 500 || !!error;
    const slow = durationMs >= slowThresholdMs(env);
    if (failed) {
      console.error(line("error", {
        event: error ? "unhandled_exception" : "server_error", request_id: requestId, method, route, status, duration_ms: durationMs,
        error_name: error ? String(error.name || "Error").slice(0, 60) : undefined,
        error_message: error ? String(error.message || "").slice(0, 300) : undefined,
        stack: error && error.stack ? String(error.stack).split("\n").slice(0, 4).join(" | ").slice(0, 500) : undefined
      }));
      const save = errorsRepo.record(env, {
        requestId, method, route, status, errorName: error ? String(error.name || "Error").slice(0, 60) : null,
        message: error ? String(error.message || "").slice(0, 300) : null
      }).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(save); else await save;
      // Optional external error tracking (ERROR_TRACKING, default off). Only a real exception is reported, never a bare 5xx.
      // It runs after the response is decided and never delays it: the tracker call is handed to waitUntil.
      if (error && errorTrackingMode(env) !== "off") {
        const report = captureException(env, ctx, error, { requestId, method, route, status });
        if (ctx && ctx.waitUntil) ctx.waitUntil(report); else await report;
      }
    } else if (slow) {
      console.warn(line("warn", { event: "slow_request", request_id: requestId, method, route, status, duration_ms: durationMs }));
    } else if (String(env?.LOG_REQUESTS || "").toLowerCase() === "all") {
      console.log(line("info", { event: "request", request_id: requestId, method, route, status, duration_ms: durationMs }));
    }
    return { route, durationMs, failed, slow };
  } catch (_) {
    return null;
  }
}
