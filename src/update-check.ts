// ============================================================
// Update Check — Non-blocking version check against npm registry
// ============================================================

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PACKAGE_NAME = 'engram-sdk';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours between checks
const STATE_DIR = join(homedir(), '.config', 'engram');
const STATE_FILE = join(STATE_DIR, 'update-check.json');

interface UpdateState {
  lastCheck: number;
  latestVersion: string | null;
  dismissed: string | null; // version the user dismissed
}

function getLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function loadState(): UpdateState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { lastCheck: 0, latestVersion: null, dismissed: null };
  }
}

function saveState(state: UpdateState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Best effort — don't crash on write failures
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Check npm registry for a newer version.
 * Non-blocking, best-effort. Prints a notice to stderr if an update is available.
 * Returns immediately — the fetch runs in the background.
 */
export function checkForUpdates(): void {
  // Opt-out: set ENGRAM_NO_UPDATE_CHECK=1 to never contact the npm registry
  if (process.env.ENGRAM_NO_UPDATE_CHECK) return;

  const state = loadState();
  const now = Date.now();

  // Don't check more than once per interval
  if (now - state.lastCheck < CHECK_INTERVAL_MS) {
    // Still show notice if we already know about an update
    if (state.latestVersion) {
      showNotice(getLocalVersion(), state.latestVersion, state.dismissed);
    }
    return;
  }

  // Non-blocking fetch — fire and forget
  fetchLatestVersion().then(latest => {
    if (!latest) return;
    const newState: UpdateState = {
      lastCheck: now,
      latestVersion: latest,
      dismissed: state.dismissed,
    };
    saveState(newState);
    showNotice(getLocalVersion(), latest, state.dismissed);
  }).catch(() => {
    // Network error — silently ignore
  });
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

function showNotice(current: string, latest: string, dismissed: string | null): void {
  if (compareVersions(latest, current) <= 0) return; // already up to date
  if (dismissed === latest) return; // user dismissed this version

  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

  console.error('');
  console.error(yellow(`  ⚠️  engram-sdk ${bold(latest)} is available ${dim(`(current: ${current})`)}`));
  console.error(`     Run: ${bold(`npm update -g engram-sdk`)}`);
  console.error('');
}

/**
 * Get the current local version string.
 */
export function getVersion(): string {
  return getLocalVersion();
}
