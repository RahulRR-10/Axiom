import { app } from 'electron';

const isDev = !app.isPackaged;

export function writeLog(label: string, err: unknown, verbose = false): void {
  const isError = label.includes('ERROR') ||
                  label.includes('CRASH') ||
                  label.includes('crash');
  if (verbose && !isDev && !isError) return;

  const msg = err instanceof Error
    ? `${err.message}\n${err.stack ?? ''}`
    : String(err);

  console.error(`[${new Date().toISOString()}] ${label}: ${msg}`);
}