import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/db';
import { startMockServer, MockServer } from './mockServer';

// short timeout and no retry delay so the suite runs fast
const app = createApp({ timeoutMs: 300, maxAttempts: 3, retryDelayMs: 0 });
let mock: MockServer;

async function registerEndpoint(path: string, events = ['order.created']) {
  const res = await request(app)
    .post('/webhook-endpoints')
    .send({ url: `${mock.baseUrl}${path}`, events });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

function sendEvent(eventId: string, eventType = 'order.created') {
  return request(app)
    .post('/events')
    .send({ eventId, eventType, payload: { orderId: 'order_123', amount: 1500 } });
}

beforeAll(async () => {
  mock = await startMockServer();
});

beforeEach(async () => {
  // children first, because of the foreign keys
  await pool.query('DELETE FROM deliveries');
  await pool.query('DELETE FROM events');
  await pool.query('DELETE FROM endpoint_subscriptions');
  await pool.query('DELETE FROM webhook_endpoints');
  mock.received.length = 0;
});

afterAll(async () => {
  await mock.close();
  await pool.end();
});

describe('POST /webhook-endpoints', () => {
  it('registers a valid endpoint', async () => {
    const res = await request(app)
      .post('/webhook-endpoints')
      .send({ url: 'https://example.com/webhook', events: ['order.created', 'order.updated'] });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(Number),
      url: 'https://example.com/webhook',
      events: ['order.created', 'order.updated'],
    });
  });

  it.each([
    [{ url: 'not-a-url', events: ['order.created'] }, 'url'],
    [{ url: 'ftp://example.com', events: ['order.created'] }, 'url'],
    [{ events: ['order.created'] }, 'url'],
    [{ url: 'https://example.com', events: [] }, 'events'],
    [{ url: 'https://example.com', events: ['order.shipped'] }, 'events'],
    [{ url: 'https://example.com' }, 'events'],
  ])('rejects invalid endpoint input %j', async (body, field) => {
    const res = await request(app).post('/webhook-endpoints').send(body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe(field);
  });
});

describe('POST /events validation', () => {
  it.each([
    [{ eventType: 'order.created', payload: {} }, 'eventId'],
    [{ eventId: '', eventType: 'order.created', payload: {} }, 'eventId'],
    [{ eventId: 'evt_1', eventType: 'order.shipped', payload: {} }, 'eventType'],
    [{ eventId: 'evt_1', eventType: 'order.created' }, 'payload'],
    [{ eventId: 'evt_1', eventType: 'order.created', payload: [1, 2] }, 'payload'],
  ])('rejects invalid event input %j', async (body, field) => {
    const res = await request(app).post('/events').send(body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe(field);
  });
});

describe('POST /events delivery', () => {
  it('accepts an event and delivers it successfully', async () => {
    const endpointId = await registerEndpoint('/ok');

    const res = await sendEvent('evt_ok');

    expect(res.status).toBe(201);
    expect(res.body.event.deliveries).toEqual([
      expect.objectContaining({ endpointId, status: 'succeeded', attempts: 1, lastStatusCode: 200 }),
    ]);
    expect(mock.received).toHaveLength(1);
    expect(mock.received[0].body).toEqual({
      eventId: 'evt_ok',
      eventType: 'order.created',
      payload: { orderId: 'order_123', amount: 1500 },
    });
  });

  it('only delivers to endpoints subscribed to the event type', async () => {
    await registerEndpoint('/ok', ['payment.failed']);

    const res = await sendEvent('evt_unsubscribed');

    expect(res.status).toBe(201);
    expect(res.body.event.deliveries).toEqual([]);
    expect(mock.received).toHaveLength(0);
  });

  it('rejects a duplicate eventId submitted sequentially', async () => {
    await registerEndpoint('/ok');

    const first = await sendEvent('evt_dup');
    const second = await sendEvent('evt_dup');

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(mock.received).toHaveLength(1);

    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_dup'");
    expect((rows as { n: number }[])[0].n).toBe(1);
  });

  it('rejects a duplicate eventId submitted concurrently', async () => {
    await registerEndpoint('/ok');

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => sendEvent('evt_race')),
    );

    const accepted = responses.filter((r) => r.status === 201);
    const duplicates = responses.filter((r) => r.status === 200 && r.body.duplicate);
    expect(accepted).toHaveLength(1);
    expect(duplicates).toHaveLength(4);
    // exactly one round of delivery happened
    expect(mock.received).toHaveLength(1);
  });

  it('retries a failing endpoint and stops at the attempt limit', async () => {
    await registerEndpoint('/fail');

    const res = await sendEvent('evt_fail');

    expect(res.status).toBe(201);
    expect(res.body.event.deliveries[0]).toEqual(
      expect.objectContaining({ status: 'failed', attempts: 3, lastStatusCode: 500 }),
    );
    expect(mock.received).toHaveLength(3);
  });

  it('succeeds on retry when an endpoint recovers', async () => {
    await registerEndpoint('/flaky');

    const res = await sendEvent('evt_flaky');

    expect(res.body.event.deliveries[0]).toEqual(
      expect.objectContaining({ status: 'succeeded', attempts: 2, lastStatusCode: 200 }),
    );
  });

  it('treats a slow endpoint as a failed attempt via the timeout', async () => {
    await registerEndpoint('/slow');

    const started = Date.now();
    const res = await sendEvent('evt_slow');

    expect(res.status).toBe(201);
    const delivery = res.body.event.deliveries[0];
    expect(delivery.status).toBe('failed');
    expect(delivery.attempts).toBe(3);
    expect(delivery.lastStatusCode).toBeNull();
    expect(delivery.lastError).toMatch(/timeout/);
    // 3 attempts x 300ms, well under the endpoint's 2s response time
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a failing endpoint does not block delivery to a healthy one', async () => {
    const okId = await registerEndpoint('/ok');
    const slowId = await registerEndpoint('/slow');

    const res = await sendEvent('evt_mixed');

    const byId = Object.fromEntries(
      res.body.event.deliveries.map((d: { endpointId: number }) => [d.endpointId, d]),
    );
    expect(byId[okId].status).toBe('succeeded');
    expect(byId[slowId].status).toBe('failed');
  });

  it('records a network error when the endpoint is unreachable', async () => {
    const res = await request(app)
      .post('/webhook-endpoints')
      .send({ url: 'http://127.0.0.1:1/hook', events: ['order.created'] });
    expect(res.status).toBe(201);

    const ev = await sendEvent('evt_unreachable');

    expect(ev.body.event.deliveries[0]).toEqual(
      expect.objectContaining({ status: 'failed', attempts: 3, lastStatusCode: null }),
    );
    expect(ev.body.event.deliveries[0].lastError).toMatch(/network error/);
  });
});

describe('GET /events/:eventId', () => {
  it('returns the event with its deliveries', async () => {
    await registerEndpoint('/ok');
    await sendEvent('evt_get');

    const res = await request(app).get('/events/evt_get');

    expect(res.status).toBe(200);
    expect(res.body.eventId).toBe('evt_get');
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.deliveries[0]).toEqual(
      expect.objectContaining({ status: 'succeeded', url: `${mock.baseUrl}/ok` }),
    );
  });

  it('returns 404 for an unknown eventId', async () => {
    const res = await request(app).get('/events/evt_missing');
    expect(res.status).toBe(404);
  });
});
