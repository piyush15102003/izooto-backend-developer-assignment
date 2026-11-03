import 'dotenv/config';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

export const config = {
  port: intFromEnv('PORT', 3000),
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: intFromEnv('DB_PORT', 3307),
    user: process.env.DB_USER ?? 'app',
    password: process.env.DB_PASSWORD ?? 'app',
    database: process.env.DB_NAME ?? 'webhooks',
  },
  delivery: {
    timeoutMs: intFromEnv('DELIVERY_TIMEOUT_MS', 5000),
    // capped at 3 because the spec allows at most 1 initial + 2 retries
    maxAttempts: Math.min(Math.max(intFromEnv('MAX_ATTEMPTS', 3), 1), 3),
    retryDelayMs: intFromEnv('RETRY_DELAY_MS', 1000),
  },
};

export type DeliveryConfig = typeof config.delivery;

export const SUPPORTED_EVENT_TYPES = [
  'order.created',
  'order.updated',
  'order.cancelled',
  'payment.succeeded',
  'payment.failed',
] as const;

export type EventType = (typeof SUPPORTED_EVENT_TYPES)[number];
