# TrazeIQ JavaScript/TypeScript SDK (`trazeiq`)

Isomorphic (Node 18+ and browsers), zero dependencies. Thin wrapper over `POST {endpoint}/api/v1/events/` — the server owns redaction, fingerprinting, grouping and incident tracking.

## Install

```bash
npm install trazeiq
```

## Usage

```ts
import { init, captureException, captureMessage } from "trazeiq";

init({
  apiKey: "YOUR_API_KEY", // raw key shown once at project creation
  endpoint: "https://api.trazeiq.io", // optional, this is the default
  environment: "production",
  service: "payment-api",
});

try {
  await processPayment(order);
} catch (error) {
  await captureException(error); // never throws, never blocks long (2s timeout)
  throw error; // TrazeIQ observes, it doesn't swallow
}

// Plain message with severity + metadata
await captureMessage("Cache hit ratio dropped below 80%", {
  level: "warning",
  metadata: { ratio: 0.74 },
});
```

## API

| Export | Purpose |
|---|---|
| `init({apiKey, endpoint?, environment?, service?, defaultMetadata?, timeoutMs?, enabled?})` | Configure. Throws only when `apiKey` is missing. |
| `captureMessage(message, opts?)` | Send a string event. No-op on empty message. |
| `captureException(error, opts?)` | Send an `Error` (extracts `message` + `stack`). Accepts anything; `null` is a no-op. |
| `wrap(fn, opts?)` | Wrap an async fn: reports rejections, then re-throws. |
| `setUser(id \| null)` | Stamp `user_id` on subsequent events. |
| `addBreadcrumb(crumb)` / `clearBreadcrumbs()` | Buffer context (kept max 50, sent as `breadcrumbs`). |
| `flush()` | No-op (sends are immediate), kept for API compatibility. |
| `close()` | Disable the client; captures become no-ops. |

Per-event `opts`: `level` (`fatal|error|warning|info|debug`, default `error`), `environment`, `service`, `endpoint`, `requestMethod`, `userId`, `ipAddress`, `metadata`, `breadcrumbs`, `stacktrace`.

## Guarantees

- **Never throws**: `captureMessage`/`captureException` always resolve — DNS/timeout/HTTP failures are swallowed.
- **Never blocks**: fire-and-forget `fetch` with a short timeout (default 2000ms, tunable via `timeoutMs`).
- **Backend contract**: sends `X-API-Key` + the `EventInputSerializer` JSON shape to `/api/v1/events/`. Oversized payloads may get HTTP 413; rate limits HTTP 429 — both swallowed client-side by design.
# TrazeIQ-JS-sdk
