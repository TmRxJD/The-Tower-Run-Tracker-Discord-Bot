import { getAppConfig } from '../config';

const DAEMON_RETRY_INTERVAL_MS = 60_000;
const DAEMON_CLIENT_ID = 'trackerbot';
const DAEMON_CLIENT_NAME = 'TrackerBot';

let daemonConnected = false;
let daemonMonitorTimer: ReturnType<typeof setInterval> | null = null;
let daemonProbeInFlight: Promise<boolean> | null = null;

function resolveDaemonBridgeBaseUrl(): string {
  const configured = String(getAppConfig().daemon.bridgeBaseUrl || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  return 'http://127.0.0.1:8787';
}

function createDaemonBridgeHeaders(baseHeaders: Record<string, string>): Record<string, string> {
  const headers = { ...baseHeaders };
  headers['x-trackerai-client-id'] = DAEMON_CLIENT_ID;
  headers['x-trackerai-client-kind'] = 'bot';
  headers['x-trackerai-client-name'] = DAEMON_CLIENT_NAME;
  const bridgeToken = String(getAppConfig().daemon.bridgeToken || '').trim();
  if (bridgeToken) {
    headers['x-bridge-token'] = bridgeToken;
  }
  return headers;
}

function setDaemonConnectionState(nextState: boolean, source: string) {
  if (nextState === daemonConnected) {
    return;
  }

  daemonConnected = nextState;
  const ts = new Date().toISOString();
  if (nextState) {
    console.info(`[${ts}] [DAEMON] connected (${source})`);
    return;
  }

  console.warn(`[${ts}] [DAEMON] disconnected (${source})`);
}

function logDaemonProbeAttempt(source: string) {
  const ts = new Date().toISOString();
  console.info(`[${ts}] [DAEMON] trying to connect (${source})`);
}

export function isDaemonConnected(): boolean {
  return daemonConnected;
}

export async function probeDaemonBridge(timeoutMs = 2500): Promise<boolean> {
  if (daemonProbeInFlight) {
    return daemonProbeInFlight;
  }

  daemonProbeInFlight = (async () => {
    try {
      const response = await fetch(`${resolveDaemonBridgeBaseUrl()}/health/bridge/ready`, {
        method: 'GET',
        headers: createDaemonBridgeHeaders({
          accept: 'application/json',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const connected = response.ok;
      setDaemonConnectionState(connected, connected ? 'health-check' : 'health-check-failed');
      return connected;
    } catch {
      setDaemonConnectionState(false, 'health-check-error');
      return false;
    } finally {
      daemonProbeInFlight = null;
    }
  })();

  return daemonProbeInFlight;
}

export function startDaemonConnectionMonitor(): void {
  if (daemonMonitorTimer) {
    return;
  }

  logDaemonProbeAttempt('startup');
  void probeDaemonBridge().then(connected => {
    if (!connected) {
      const ts = new Date().toISOString();
      console.warn(`[${ts}] [DAEMON] unavailable at startup; continuing without daemon and retrying every 60s`);
    }
  });

  daemonMonitorTimer = setInterval(() => {
    if (!daemonConnected) {
      logDaemonProbeAttempt('retry');
    }
    void probeDaemonBridge();
  }, DAEMON_RETRY_INTERVAL_MS);
}

export async function runDaemonUniversalCommand<TResponse = Record<string, unknown>>(
  commandName: string,
  payload: {
    user?: Record<string, unknown>;
    args?: Record<string, unknown> | string;
    context?: Record<string, unknown>;
  },
): Promise<TResponse> {
  const normalizedCommand = String(commandName || '').trim().toLowerCase();
  if (!normalizedCommand) {
    throw new Error('commandName is required');
  }

  let response: Response;
  try {
    response = await fetch(`${resolveDaemonBridgeBaseUrl()}/commands/${encodeURIComponent(normalizedCommand)}`, {
      method: 'POST',
      headers: createDaemonBridgeHeaders({
        'content-type': 'application/json',
      }),
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    setDaemonConnectionState(false, `command:${normalizedCommand}:error`);
    throw error;
  }

  setDaemonConnectionState(true, `command:${normalizedCommand}`);

  const body = (await response.json().catch(() => ({}))) as TResponse & { error?: string };
  if (!response.ok) {
    setDaemonConnectionState(false, `command:${normalizedCommand}:failed`);
    throw new Error(typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : 'Daemon command failed');
  }

  return body;
}

export async function runDaemonOcr(payload: {
  fileName: string;
  mimeType?: string;
  imageBase64: string;
}): Promise<Record<string, unknown>> {
  const result = await runDaemonUniversalCommand<{ payload?: Record<string, unknown> }>('ocr', {
    args: payload,
    context: {
      source: 'trackerbot',
    },
  });

  return result?.payload && typeof result.payload === 'object'
    ? result.payload
    : {};
}
