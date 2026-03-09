import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/* ── Crash logging ─────────────────────────────────────────────────────────── */
const logFile = path.join(app.getPath('userData'), 'crash.log');
const isDev = !app.isPackaged;

export function writeLog(label: string, err: unknown, verbose = false): void {
  // always write crashes and errors regardless of environment
  const isError = label.includes('ERROR') ||
                  label.includes('CRASH') ||
                  label.includes('crash');

  // skip verbose logs in production
  if (verbose && !isDev && !isError) return;

  const msg = err instanceof Error
    ? `${err.message}\n${err.stack ?? ''}`
    : String(err);
  const line = `[${new Date().toISOString()}] ${label}: ${msg}\n`;
  try { fs.appendFileSync(logFile, line); } catch { /* ignore */ }
  console.error(line);
}

export { logFile };
