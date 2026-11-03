import { SUPPORTED_EVENT_TYPES, EventType } from './config';

export class ValidationError extends Error {
  constructor(public field: string, message: string) {
    super(message);
  }
}

function isSupportedEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (SUPPORTED_EVENT_TYPES as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateEndpointInput(body: unknown): { url: string; events: EventType[] } {
  if (!isPlainObject(body)) throw new ValidationError('body', 'request body must be a JSON object');

  const { url, events } = body;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new ValidationError('url', 'url is required and must be a string');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('url', 'url must be a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('url', 'url must use http or https');
  }

  if (!Array.isArray(events) || events.length === 0) {
    throw new ValidationError('events', 'events must be a non-empty array');
  }
  for (const e of events) {
    if (!isSupportedEventType(e)) {
      throw new ValidationError(
        'events',
        `unsupported event type "${e}"; supported: ${SUPPORTED_EVENT_TYPES.join(', ')}`,
      );
    }
  }

  // de-duplicate so ["order.created", "order.created"] doesn't hit the subscription PK
  return { url, events: [...new Set(events as EventType[])] };
}

export function validateEventInput(body: unknown): {
  eventId: string;
  eventType: EventType;
  payload: Record<string, unknown>;
} {
  if (!isPlainObject(body)) throw new ValidationError('body', 'request body must be a JSON object');

  const { eventId, eventType, payload } = body;
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    throw new ValidationError('eventId', 'eventId is required and must be a non-empty string');
  }
  if (eventId.length > 255) {
    throw new ValidationError('eventId', 'eventId must be at most 255 characters');
  }
  if (!isSupportedEventType(eventType)) {
    throw new ValidationError(
      'eventType',
      `eventType must be one of: ${SUPPORTED_EVENT_TYPES.join(', ')}`,
    );
  }
  if (!isPlainObject(payload)) {
    throw new ValidationError('payload', 'payload is required and must be a JSON object');
  }
  return { eventId, eventType, payload };
}
