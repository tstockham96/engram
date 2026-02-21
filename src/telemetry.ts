/**
 * Engram Anonymous Telemetry
 *
 * Collects lightweight, anonymous usage data to help improve Engram.
 *
 * What's collected:
 *   - A random anonymous ID (UUID, not tied to any personal info)
 *   - Event type (server_start, init, daily_heartbeat)
 *   - Engram version, platform, architecture, Node.js version
 *   - Vault stats (memory count, entity count — no content)
 *   - Timestamp
 *
 * How to opt out:
 *   Set either environment variable:
 *     ENGRAM_TELEMETRY=off
 *     DO_NOT_TRACK=1
 *
 * All telemetry is fire-and-forget — it never blocks, never throws,
 * and fails silently with a 2-second timeout.
 */

import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const COLLECTOR_URL = 'https://telemetry.engram.fyi/v1/ping';
const TIMEOUT_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let cachedId: string | null = null;

function isOptedOut(): boolean {
  return (
    process.env.ENGRAM_TELEMETRY === 'off' ||
    process.env.DO_NOT_TRACK === '1'
  );
}

function getConfigDir(): string {
  return join(homedir(), '.config', 'engram');
}

function getTelemetryId(): string {
  if (cachedId) return cachedId;
  const idPath = join(getConfigDir(), 'telemetry-id');
  try {
    if (existsSync(idPath)) {
      cachedId = readFileSync(idPath, 'utf-8').trim();
      if (cachedId) return cachedId;
    }
  } catch { /* ignore */ }

  cachedId = randomUUID();
  try {
    mkdirSync(dirname(idPath), { recursive: true });
    writeFileSync(idPath, cachedId);
  } catch { /* ignore */ }
  return cachedId;
}

function getVersion(): string {
  try {
    const pkgPath = join(dirname(new URL(import.meta.url).pathname), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function getLastPingPath(): string {
  return join(getConfigDir(), 'last-ping');
}

function shouldSendHeartbeat(): boolean {
  try {
    const lastPingPath = getLastPingPath();
    if (!existsSync(lastPingPath)) return true;
    const lastPing = parseInt(readFileSync(lastPingPath, 'utf-8').trim(), 10);
    return Date.now() - lastPing > HEARTBEAT_INTERVAL_MS;
  } catch {
    return true;
  }
}

function recordPing(): void {
  try {
    const lastPingPath = getLastPingPath();
    mkdirSync(dirname(lastPingPath), { recursive: true });
    writeFileSync(lastPingPath, String(Date.now()));
  } catch { /* ignore */ }
}

export type TelemetryEvent = 'server_start' | 'init' | 'daily_heartbeat';

export interface VaultStats {
  memories: number;
  entities: number;
}

function sendPing(event: TelemetryEvent, vaultStats?: VaultStats): void {
  if (isOptedOut()) return;

  try {
    const payload = {
      id: getTelemetryId(),
      event,
      version: getVersion(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      vaultStats: vaultStats ?? { memories: 0, entities: 0 },
      timestamp: new Date().toISOString(),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    fetch(COLLECTOR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then(() => { recordPing(); })
      .catch(() => { /* silently ignore */ })
      .finally(() => { clearTimeout(timer); });
  } catch { /* silently ignore */ }
}

/**
 * Send an event ping (server_start or init).
 * Fire-and-forget — never blocks, never throws.
 */
export function trackEvent(event: TelemetryEvent, vaultStats?: VaultStats): void {
  try {
    sendPing(event, vaultStats);
  } catch { /* silently ignore */ }
}

/**
 * Check if a daily heartbeat is due, and send one if so.
 * Fire-and-forget — never blocks, never throws.
 */
export function trackHeartbeatIfDue(vaultStats?: VaultStats): void {
  try {
    if (isOptedOut()) return;
    if (shouldSendHeartbeat()) {
      sendPing('daily_heartbeat', vaultStats);
    }
  } catch { /* silently ignore */ }
}
