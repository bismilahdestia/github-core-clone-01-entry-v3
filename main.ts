// Entry lifecycle: bind the forge on an ephemeral port, tell the trial env
// which port that is, then wait until the env reports the trial is done.
//
// The env drives everything through MAKEFUN_ENV_URL:
//   - POST /register {"port": N} announces this process's base URL. The first
//     registration wins; a 409 means another entry registered first, and this
//     process simply waits like any other.
//   - GET /done answers {"done": false} while the suite runs and
//     {"done": true} when it is over. The process never exits before that.
// Port 8080 belongs to the env, so the server always listens on port 0 and
// lets the kernel pick a free one.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One request may take at most 30 s; retries back off exponentially.
const TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

/** Sleep for `ms` milliseconds. */
const nap = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff for env calls, capped so retries stay frequent. */
function backoffMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/** POST a JSON body to the trial env. */
async function postEnv(path: string, body: unknown): Promise<Response> {
  return fetch(`${envUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// Announce the bound port. A 200 or a 409 both mean "registered"; 400/405 are
// contract errors and stop the process; anything else (the env may still be
// starting) is retried.
async function registerEnv(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await postEnv('/register', { port });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await nap(backoffMs(attempt));
  }
}

// Poll GET /done until the env says the trial is over. A failed poll is not
// an error: the env may not be answering yet, so the loop just tries again.
async function waitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet: keep polling.
    }
    await nap(backoffMs(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }

  // Shut the server down cleanly if the harness stops this process early.
  let closing = false;
  const stopServer = (): void => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', stopServer);
  process.once('SIGINT', stopServer);

  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await registerEnv(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
