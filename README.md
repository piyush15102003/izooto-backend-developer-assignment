# Webhook Delivery API

Customers register webhook endpoints and submit events. Each accepted event is delivered to every endpoint subscribed to its type, with a timeout on every attempt and at most 3 attempts per endpoint.

Stack: Node.js, Express, MySQL 8, TypeScript. Tests use Jest + Supertest against a real MySQL and a local mock HTTP server.

## Setup

Requirements: Node 18+ (uses built-in `fetch`), Docker.

```bash
# 1. start MySQL (port 3307); the schema in sql/ is applied automatically on first start
docker compose up -d

# 2. install dependencies
npm install

# 3. run the API
npm run dev            # dev mode with reload
# or
npm run build && npm start

# 4. run the tests (MySQL must be up)
npm test
```

To reset the database: `docker compose down -v && docker compose up -d`.

Not using Docker? Create a database and run `sql/001_schema.sql` against it, then point the `DB_*` variables at it.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `DB_HOST` / `DB_PORT` | 127.0.0.1 / 3307 | MySQL address |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | app / app / webhooks | MySQL credentials |
| `DELIVERY_TIMEOUT_MS` | 5000 | Timeout for each delivery attempt |
| `MAX_ATTEMPTS` | 3 | Attempts per endpoint (clamped to 1–3) |
| `RETRY_DELAY_MS` | 1000 | Wait between attempts |

## API

### `POST /webhook-endpoints`
```json
{ "url": "https://example.com/webhook", "events": ["order.created", "order.updated"] }
```
`201` → `{ "id": 1, "url": "...", "events": [...] }`
`400` → `{ "error": "...", "field": "url" }` (the `field` says which input is wrong)

### `POST /events`
```json
{ "eventId": "evt_1001", "eventType": "order.created", "payload": { "orderId": "order_123", "amount": 1500 } }
```
- `201` → new event accepted; body contains the event and the result for each endpoint.
- `200` → duplicate `eventId`; body is `{ "duplicate": true, "event": <existing event> }`, nothing is re-delivered.
- `400` → validation error with `field`.

### `GET /events/:eventId`
Returns the event and one delivery record per endpoint (`endpointId`, `url`, `status`, `attempts`, `lastStatusCode`, `lastError`, timestamps). `404` if unknown.

## Design decisions

### Duplicate events → `200` with the existing event
Senders retry when they don't get a response (timeouts, dropped connections), so seeing the same `eventId` twice is normal, not a client mistake. Returning `200` with the stored event makes the endpoint idempotent: the caller gets the same result as the first time and can safely retry. `duplicate: true` lets them tell the two cases apart if they care. `409` would also work but forces every client to treat a harmless retry as an error.

### How duplicates are blocked under concurrency
`events.event_id` has a `UNIQUE` index. The handler does a plain `INSERT` (no "check then insert", which races). If two requests arrive at the same moment, InnoDB lets exactly one insert succeed; the other gets `ER_DUP_ENTRY`, which we catch and turn into the duplicate response **before** any delivery happens. Because the check lives in the database, it also holds when running several app instances.
`deliveries` also has `UNIQUE(event_id, endpoint_id)` as a second guard.

### Event accepted but deliveries failed → still `201`
The request's job is to accept the event, and it did: it's stored and every attempt is recorded. A failing customer endpoint isn't a bad request (4xx) and isn't our server failing (5xx). Returning 5xx would also push the sender to retry, which would just come back as a duplicate. The response body shows per-endpoint `status` (`succeeded` / `failed`), so the caller can see exactly what failed, and `GET /events/:eventId` shows the same later.

### Retry strategy: fixed delay
Up to 3 attempts per endpoint, with a fixed `RETRY_DELAY_MS` between them. Delivery has to happen inside the request, so the client waits for all of it. With only 2 retries, exponential backoff doesn't buy much, and a fixed delay keeps the worst case easy to reason about: about `3 × 5s + 2 × 1s ≈ 17s`. Endpoints are delivered in parallel (`Promise.allSettled`), so that worst case doesn't grow with the number of endpoints, and one slow or broken endpoint doesn't hold up or cancel the others.
The retry loop is a bounded `for` loop, so there's no way for it to run forever. Delay and attempts are configurable; tests use a 300 ms timeout and 0 ms delay.

What counts as a failed attempt: any non-2xx status, a network error, or the timeout (`AbortSignal.timeout`). None of these throw out of the delivery code, so a bad endpoint can't crash the app.

### Schema (`sql/001_schema.sql`)
- `webhook_endpoints`: the URL.
- `endpoint_subscriptions(event_type, endpoint_id)`: primary key starts with `event_type`, so "who subscribes to `order.created`?" is an index lookup. It also stops duplicate subscriptions.
- `events`: `UNIQUE(event_id)`, payload stored as `JSON`.
- `deliveries`: one row per (event, endpoint) with foreign keys to both; status (`pending` / `succeeded` / `failed`), attempts, last status code, last error, timestamps. It's updated after every attempt, not only at the end.

Registering an endpoint inserts the endpoint and its subscriptions in one transaction.

## Known limitations

- **Process crash mid-delivery:** the event is already committed, so its delivery rows stay `pending` with however many attempts were recorded. Nothing picks them up again (no worker, as required), and resubmitting the event is treated as a duplicate, so those deliveries are stuck. A receiver might also get the webhook again if we crash after they returned 2xx but before we saved it, so receivers should dedupe on `eventId`. The real fix is an outbox-style background worker that retries old `pending` rows.
- Requests can be slow (up to ~17s with defaults) when an endpoint is down, because delivery is synchronous.
- Delivering to a URL means our server makes requests to whatever the customer registered. There's no protection against internal addresses (SSRF).
- No authentication, webhook signing, pagination, or endpoint update/delete (out of scope).

