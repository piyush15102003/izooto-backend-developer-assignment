import { Router, Request, Response, NextFunction } from 'express';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { pool, isDuplicateKeyError } from './db';
import { validateEndpointInput, validateEventInput } from './validation';
import { deliverEvent } from './delivery';
import { DeliveryConfig } from './config';

// wraps async handlers so a rejected promise reaches the error middleware
const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

async function loadEvent(eventId: string) {
  const [events] = await pool.execute<RowDataPacket[]>(
    'SELECT id, event_id, event_type, payload, created_at FROM events WHERE event_id = ?',
    [eventId],
  );
  if (events.length === 0) return null;
  const event = events[0];

  const [deliveries] = await pool.execute<RowDataPacket[]>(
    `SELECT d.endpoint_id, e.url, d.status, d.attempts, d.last_status_code, d.last_error,
            d.created_at, d.last_attempt_at, d.completed_at
       FROM deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.event_id = ?
      ORDER BY d.endpoint_id`,
    [event.id],
  );

  return {
    eventId: event.event_id,
    eventType: event.event_type,
    payload: event.payload,
    createdAt: event.created_at,
    deliveries: deliveries.map((d) => ({
      endpointId: d.endpoint_id,
      url: d.url,
      status: d.status,
      attempts: d.attempts,
      lastStatusCode: d.last_status_code,
      lastError: d.last_error,
      createdAt: d.created_at,
      lastAttemptAt: d.last_attempt_at,
      completedAt: d.completed_at,
    })),
  };
}

export function buildRouter(deliveryConfig: DeliveryConfig): Router {
  const router = Router();

  router.post(
    '/webhook-endpoints',
    asyncHandler(async (req, res) => {
      const { url, events } = validateEndpointInput(req.body);

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [result] = await conn.execute<ResultSetHeader>(
          'INSERT INTO webhook_endpoints (url) VALUES (?)',
          [url],
        );
        const endpointId = result.insertId;
        await conn.query('INSERT INTO endpoint_subscriptions (event_type, endpoint_id) VALUES ?', [
          events.map((e) => [e, endpointId]),
        ]);
        await conn.commit();
        res.status(201).json({ id: endpointId, url, events });
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }),
  );

  router.post(
    '/events',
    asyncHandler(async (req, res) => {
      const { eventId, eventType, payload } = validateEventInput(req.body);

      // no SELECT-then-INSERT: the UNIQUE key on event_id decides the winner atomically
      let eventRowId: number;
      try {
        const [result] = await pool.execute<ResultSetHeader>(
          'INSERT INTO events (event_id, event_type, payload) VALUES (?, ?, ?)',
          [eventId, eventType, JSON.stringify(payload)],
        );
        eventRowId = result.insertId;
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          const existing = await loadEvent(eventId);
          return res.status(200).json({ duplicate: true, event: existing });
        }
        throw err;
      }

      const [targets] = await pool.execute<RowDataPacket[]>(
        `SELECT e.id AS endpointId, e.url
           FROM endpoint_subscriptions s
           JOIN webhook_endpoints e ON e.id = s.endpoint_id
          WHERE s.event_type = ?`,
        [eventType],
      );

      await deliverEvent(
        eventRowId,
        targets as { endpointId: number; url: string }[],
        { eventId, eventType, payload },
        deliveryConfig,
      );

      res.status(201).json({ duplicate: false, event: await loadEvent(eventId) });
    }),
  );

  router.get(
    '/events/:eventId',
    asyncHandler(async (req, res) => {
      const event = await loadEvent(req.params.eventId);
      if (!event) return res.status(404).json({ error: 'event not found' });
      res.json(event);
    }),
  );

  return router;
}
