/**
 * TrazeIQ JavaScript/TypeScript SDK — isomorphic (Node 18+ and browsers).
 *
 * Thin wrapper over `POST {endpoint}/api/v1/events/` with `X-API-Key` auth.
 * It mirrors the backend `EventInputSerializer` fields and nothing else:
 * the server owns redaction, fingerprinting, grouping and incident tracking.
 *
 * Guarantees (the System Agent contract from the TrazeIQ spec):
 * - never throws: every public capture call resolves, never rejects,
 *   and swallows transport errors internally;
 * - never blocks the host app: sends are fire-and-forget `fetch` calls
 *   with a short timeout (default 2s) and no retries.
 */

export type TrazeLevel = "fatal" | "error" | "warning" | "info" | "debug";

export interface TrazeBreadcrumb {
  message: string;
  level?: TrazeLevel;
  timestamp?: string;
  [key: string]: unknown;
}

export interface TrazeInitOptions {
  /** Project API key (the raw key shown once at project creation). */
  apiKey: string;
  /**
   * Base URL of the TrazeIQ API, e.g. `https://api.trazeiq.io`.
   * The SDK appends `/api/v1/events/` automatically.
   */
  endpoint?: string;
  /** Default environment stamped on every event (e.g. "production"). */
  environment?: string;
  /** Default service name stamped on every event (e.g. "payment-api"). */
  service?: string;
  /** Per-event metadata merged under `metadata`. */
  defaultMetadata?: Record<string, unknown>;
  /** Abort in-flight sends after this many ms. Default 2000. */
  timeoutMs?: number;
  /** When false, all captures are no-ops (useful for local dev). Default true. */
  enabled?: boolean;
}

export interface TrazeCaptureOptions {
  level?: TrazeLevel;
  environment?: string;
  service?: string;
  endpoint?: string;
  requestMethod?: string;
  userId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
  breadcrumbs?: TrazeBreadcrumb[];
  stacktrace?: string;
}

interface ResolvedConfig {
  apiKey: string;
  eventsUrl: string;
  environment: string;
  service: string;
  defaultMetadata: Record<string, unknown>;
  timeoutMs: number;
  enabled: boolean;
}

const DEFAULT_ENDPOINT = "https://api.trazeiq.io";
const DEFAULT_TIMEOUT_MS = 2000;

let config: ResolvedConfig | null = null;
let userId: string | null = null;
let globalBreadcrumbs: TrazeBreadcrumb[] = [];

function normalizeBaseUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

/** Configure the SDK. Must be called before any capture call. */
export function init(options: TrazeInitOptions): void {
  if (!options || typeof options.apiKey !== "string" || options.apiKey === "") {
    throw new Error("trazeiq: init() requires a non-empty apiKey.");
  }
  const base = normalizeBaseUrl(options.endpoint ?? DEFAULT_ENDPOINT);
  config = {
    apiKey: options.apiKey,
    eventsUrl: `${base}/api/v1/events/`,
    environment: options.environment ?? "",
    service: options.service ?? "",
    defaultMetadata: options.defaultMetadata ?? {},
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    enabled: options.enabled ?? true,
  };
}

/** Reset internal state (mainly for tests). */
export function __resetForTests(): void {
  config = null;
  userId = null;
  globalBreadcrumbs = [];
}

/** Attach a user id to subsequent events. */
export function setUser(id: string | null): void {
  userId = id;
}

/** Append a breadcrumb kept for subsequent events (capped at 50). */
export function addBreadcrumb(crumb: TrazeBreadcrumb): void {
  globalBreadcrumbs = [...globalBreadcrumbs, crumb].slice(-50);
}

/** Clear buffered breadcrumbs. */
export function clearBreadcrumbs(): void {
  globalBreadcrumbs = [];
}

/** Disable the client — subsequent captures are no-ops. */
export function close(): void {
  if (config) config.enabled = false;
}

function getConfig(): ResolvedConfig | null {
  return config;
}

interface EventPayload {
  message: string;
  stacktrace: string;
  level: TrazeLevel;
  environment: string;
  service: string;
  endpoint: string;
  request_method: string;
  user_id: string;
  ip_address: string;
  metadata: Record<string, unknown>;
  breadcrumbs: TrazeBreadcrumb[];
}

function buildPayload(message: string, opts: TrazeCaptureOptions): EventPayload {
  const cfg = getConfig();
  return {
    message,
    stacktrace: opts.stacktrace ?? "",
    level: opts.level ?? "error",
    environment: opts.environment ?? cfg?.environment ?? "",
    service: opts.service ?? cfg?.service ?? "",
    endpoint: opts.endpoint ?? "",
    request_method: opts.requestMethod ?? "",
    user_id: opts.userId ?? userId ?? "",
    ip_address: opts.ipAddress ?? "",
    metadata: { ...(cfg?.defaultMetadata ?? {}), ...(opts.metadata ?? {}) },
    breadcrumbs: opts.breadcrumbs ?? [...globalBreadcrumbs],
  };
}

function send(payload: EventPayload): Promise<void> {
  const cfg = getConfig();
  if (!cfg || !cfg.enabled) return Promise.resolve();
  const fetchFn: typeof fetch | undefined =
    typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
  if (!fetchFn) return Promise.resolve();
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer =
    controller != null
      ? setTimeout(() => controller.abort(), cfg.timeoutMs)
      : null;
  // Never rejects: transport/DNS/timeout errors are swallowed so the
  // host app is never affected by a monitoring failure.
  return fetchFn(cfg.eventsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": cfg.apiKey },
    body: JSON.stringify(payload),
    ...(controller != null ? { signal: controller.signal } : {}),
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (timer != null) clearTimeout(timer);
    });
}

/**
 * Report a string message. Never throws — the returned promise
 * always resolves, even when the transport fails.
 */
export function captureMessage(
  message: string,
  opts: TrazeCaptureOptions = {},
): Promise<void> {
  if (typeof message !== "string" || message === "") return Promise.resolve();
  return send(buildPayload(message, opts));
}

function stackOf(error: unknown): string {
  if (error instanceof Error) return error.stack ?? String(error);
  return "";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Unknown error";
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

/**
 * Report an exception/error object. Extracts `message` + `stack`
 * automatically; pass `{level: "fatal"}` to escalate severity.
 * Never throws — always resolves.
 */
export function captureException(
  error: unknown,
  opts: TrazeCaptureOptions = {},
): Promise<void> {
  if (error == null) return Promise.resolve();
  return send(
    buildPayload(messageOf(error), {
      ...opts,
      stacktrace: opts.stacktrace ?? stackOf(error),
    }),
  );
}

/**
 * Wrap an async function so rejections are reported before re-throwing.
 * TrazeIQ observes — it never swallows.
 */
export function wrap<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  opts: TrazeCaptureOptions = {},
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    try {
      return await fn(...args);
    } catch (error) {
      await captureException(error, opts);
      throw error;
    }
  };
}

/** Flush is a no-op (sends are immediate) kept for API compatibility. */
export function flush(): Promise<void> {
  return Promise.resolve();
}
