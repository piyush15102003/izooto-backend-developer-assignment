import express, { Request, Response, NextFunction } from 'express';
import { buildRouter } from './routes';
import { ValidationError } from './validation';
import { config, DeliveryConfig } from './config';

// deliveryConfig is injectable so tests can use short timeouts and zero retry delay
export function createApp(deliveryConfig: DeliveryConfig = config.delivery) {
  const app = express();
  app.use(express.json());
  app.use(buildRouter(deliveryConfig));

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message, field: err.field });
    }
    // malformed JSON body from express.json()
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'request body is not valid JSON', field: 'body' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
