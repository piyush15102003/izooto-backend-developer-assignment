import { createApp } from './app';
import { config } from './config';

const app = createApp();

app.listen(config.port, () => {
  console.log(`webhook API listening on port ${config.port}`);
});

// last line of defence: log instead of crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason);
});
