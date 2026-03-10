import { app } from 'electron';
import * as path from 'path';
import { Worker } from 'worker_threads';

import { writeLog } from '../logger';
import { MODEL_NAME } from './embedder';

const SEARCH_TIMEOUT_MS = 8_000;
const INDEX_TIMEOUT_MS  = 60_000;
const DIM = 384;
const MODEL_BATCH = 48;

let searchWorker: Worker | null = null;
let indexWorker:  Worker | null = null;
let msgCounter = 0;

type PendingCall = {
  resolve: (v: number[][]) => void;
  reject:  (e: Error)      => void;
};

const searchPending = new Map<number, PendingCall>();
const indexPending  = new Map<number, PendingCall>();

let shuttingDown = false;

// ── Inline worker source (same isolate as embedder.ts) ───────────────────────
const EMBEDDER_WORKER_CODE = String.raw`
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { createRequire } = require('module');
const os = require('os');

let extractor = null;

async function init() {
  if (extractor) return;
  const localRequire = createRequire(workerData.resolveDir + '/package.json');
  const transformers = localRequire('@xenova/transformers');
  const pipeline = transformers.pipeline;
  const env = transformers.env;
  if (env) {
    env.cacheDir = workerData.modelsDir;
    if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
      env.backends.onnx.wasm.numThreads = os.cpus().length || 4;
      env.backends.onnx.wasm.simd       = true;
      env.backends.onnx.wasm.proxy      = false;
    }
  }
  extractor = await pipeline('feature-extraction', '${MODEL_NAME}', {
    quantized: true,
  });
}

parentPort.on('message', async function(msg) {
  try {
    if (msg.type === 'warmup') {
      await init();
      parentPort.postMessage({ id: msg.id, type: 'ready' });
      return;
    }
    await init();
    var texts = msg.texts;
    var dim = ${DIM};
    var MB = ${MODEL_BATCH};
    var vectors = [];
    for (var i = 0; i < texts.length; i += MB) {
      var batch = texts.slice(i, i + MB);
      var output = await extractor(batch, { pooling: 'mean', normalize: true });
      var data = output.data;
      for (var j = 0; j < batch.length; j++) {
        vectors.push(Array.from(data.slice(j * dim, (j + 1) * dim)));
      }
    }
    parentPort.postMessage({ id: msg.id, type: 'result', vectors: vectors });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, type: 'error', error: String((err && err.message) || err) });
  }
});
`;

function spawnWorker(label: string, pending: Map<number, PendingCall>): Worker {
  const modelsDir = path.join(app.getPath('userData'), 'models');

  const w = new Worker(EMBEDDER_WORKER_CODE, {
    eval: true,
    workerData: { modelsDir, resolveDir: __dirname },
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
  });

  try { writeLog(`embedder:${label}`, 'Worker spawned'); } catch { /* ignore */ }

  w.on('message', (msg: { id: number; type: string; vectors?: number[][]; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.error));
    else p.resolve(msg.vectors ?? []);
  });

  w.on('error', (err: unknown) => {
    try { writeLog(`embedder:${label}:ERROR`, `Worker crashed: ${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ }
    const error = err instanceof Error ? err : new Error(String(err));
    for (const [, p] of pending) p.reject(error);
    pending.clear();
  });

  w.on('exit', (code) => {
    if (code !== 0) {
      try { writeLog(`embedder:${label}:ERROR`, `Worker exited code:${code}`); } catch { /* ignore */ }
    }
    if (code !== 0 && !shuttingDown) {
      // Crash recovery: respawn the worker and reinitialize the model
      try { writeLog(`embedder:${label}`, `Respawning after crash (code ${code})`); } catch { /* ignore */ }
      const replacement = spawnWorker(label, pending);
      if (label === 'search') searchWorker = replacement;
      else indexWorker = replacement;
      sendWarmup(replacement).then(() => {
        try { writeLog(`embedder:${label}`, 'Respawned worker ready'); } catch { /* ignore */ }
      }).catch((err) => {
        try { writeLog(`embedder:${label}:ERROR`, `Respawn warmup failed: ${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ }
      });
    }
    if (pending.size > 0) {
      const exitError = new Error(`${label} worker exited unexpectedly (code ${code})`);
      for (const [, p] of pending) p.reject(exitError);
      pending.clear();
    }
  });

  return w;
}

function sendWarmup(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = ++msgCounter;
    const timer = setTimeout(() => reject(new Error('Worker init timed out')), 30_000);

    const handler = (msg: { id: number; type: string }) => {
      if (msg.id === id && msg.type === 'ready') {
        clearTimeout(timer);
        worker.removeListener('message', handler);
        resolve();
      }
    };
    worker.on('message', handler);
    worker.postMessage({ id, type: 'warmup' });
  });
}

function callWorker(
  worker: Worker,
  pending: Map<number, PendingCall>,
  texts: string[],
  timeoutMs: number,
): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const id = ++msgCounter;

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Embed timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject:  e => { clearTimeout(timer); reject(e); },
    });

    worker.postMessage({ id, texts });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initEmbedders(): Promise<void> {
  searchWorker = spawnWorker('search', searchPending);
  indexWorker  = spawnWorker('index', indexPending);
  await Promise.all([
    sendWarmup(searchWorker),
    sendWarmup(indexWorker),
  ]);
}

/** Dedicated search worker — never blocked by indexing batches */
export function embedQuery(texts: string[]): Promise<number[][]> {
  if (!searchWorker) throw new Error('Search worker not initialized');
  return callWorker(searchWorker, searchPending, texts, SEARCH_TIMEOUT_MS);
}

/** Dedicated indexing worker — never blocks search */
export function embedChunks(texts: string[]): Promise<number[][]> {
  if (!indexWorker) throw new Error('Index worker not initialized');
  return callWorker(indexWorker, indexPending, texts, INDEX_TIMEOUT_MS);
}

export function teardownEmbedders(): void {
  shuttingDown = true;
  searchWorker?.terminate();
  indexWorker?.terminate();
  searchWorker = null;
  indexWorker  = null;
}
