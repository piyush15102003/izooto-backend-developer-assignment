import { pool } from './db';
import { DeliveryConfig } from './config';

export interface WebhookBody {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

interface Target {
  endpointId: number;
  url: string;
}

interface AttemptResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function attemptOnce(url: string, body: WebhookBody, timeoutMs: number): Promise<AttemptResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // aborts the request, including a slow body, once the timeout passes
      signal: AbortSignal.timeout(timeoutMs),
    });
    // drain the body so the socket is released; we don't use the content
    await res.arrayBuffer().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, statusCode: res.status, error: null };
    }
    return { ok: false, statusCode: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    const name = (err as Error)?.name;
    const message =
      name === 'TimeoutError' || name === 'AbortError'
        ? `timeout after ${timeoutMs}ms`
        : `network error: ${(err as Error)?.message ?? String(err)}`;
    return { ok: false, statusCode: null, error: message };
  }
}

async function deliverToEndpoint(
  eventRowId: number,
  target: Target,
  body: WebhookBody,
  cfg: DeliveryConfig,
): Promise<void> {
  // for-loop with a fixed upper bound: there is no path to an infinite retry
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    const result = await attemptOnce(target.url, body, cfg.timeoutMs);
    const isLast = attempt === cfg.maxAttempts;
    const status = result.ok ? 'succeeded' : isLast ? 'failed' : 'pending';

    await pool.execute(
      `UPDATE deliveries
          SET status = ?, attempts = ?, last_status_code = ?, last_error = ?,
              last_attempt_at = CURRENT_TIMESTAMP(3),
              completed_at = IF(? IN ('succeeded', 'failed'), CURRENT_TIMESTAMP(3), NULL)
        WHERE event_id = ? AND endpoint_id = ?`,
      [status, attempt, result.statusCode, result.error, status, eventRowId, target.endpointId],
    );

    if (result.ok) return;
    if (!isLast) await sleep(cfg.retryDelayMs);
  }
}

export async function deliverEvent(
  eventRowId: number,
  targets: Target[],
  body: WebhookBody,
  cfg: DeliveryConfig,
): Promise<void> {
  if (targets.length === 0) return;

  const placeholders = targets.map(() => '(?, ?)').join(', ');
  await pool.execute(
    `INSERT INTO deliveries (event_id, endpoint_id) VALUES ${placeholders}`,
    targets.flatMap((t) => [eventRowId, t.endpointId]),
  );

  // allSettled: one endpoint throwing (e.g. a DB hiccup on its update) can't cancel the others
  const results = await Promise.allSettled(
    targets.map((t) => deliverToEndpoint(eventRowId, t, body, cfg)),
  );
  for (const r of results) {
    if (r.status === 'rejected') console.error('delivery bookkeeping failed:', r.reason);
  }
}
