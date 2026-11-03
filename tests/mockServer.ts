import http from 'http';
import { AddressInfo } from 'net';

export interface ReceivedRequest {
  path: string;
  body: unknown;
}

export interface MockServer {
  baseUrl: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

// routes:
//   /ok        -> 200
//   /fail      -> 500
//   /slow      -> waits 2s, then 200 (longer than the test timeout)
//   /flaky     -> 500 on the first call, 200 after
export async function startMockServer(): Promise<MockServer> {
  const received: ReceivedRequest[] = [];
  let flakyCalls = 0;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : null });

      if (req.url === '/ok') {
        res.writeHead(200).end('ok');
      } else if (req.url === '/fail') {
        res.writeHead(500).end('boom');
      } else if (req.url === '/slow') {
        const timer = setTimeout(() => res.writeHead(200).end('late'), 2000);
        res.on('close', () => clearTimeout(timer));
      } else if (req.url === '/flaky') {
        flakyCalls++;
        res.writeHead(flakyCalls === 1 ? 500 : 200).end();
      } else {
        res.writeHead(404).end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
