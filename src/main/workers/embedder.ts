import { app } from 'electron';
import * as path from 'path';
import { Worker } from 'worker_threads';

import { writeLog } from '../logger';

// ── Persistent worker thread for embedding ───────────────────────────────────
// All ONNX model inference runs off the main thread so the UI never blocks.
// The worker loads the model once and processes batched requests via messages.

export const MODEL_NAME = 'Xenova/bge-small-en-v1.5';
const DIM = 384; // bge-small-en-v1.5 output dimension
const MODEL_BATCH = 48; // optimal for bge-small on WASM
const ZERO_VEC: number[] = new Array(DIM).fill(0);

// QUERY prefix — REQUIRED for bge, never skip this
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
// DOC prefix for chunks during indexing
export const DOC_PREFIX = 'Represent this document for retrieval: ';

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();

// ── Worker source (plain JS — runs in its own V8 isolate) ────────────────────
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
    // ── CRITICAL PERFORMANCE FLAGS ──────────────────────────────────────────
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
    var MODEL_BATCH = ${MODEL_BATCH};
    var vectors = [];
    for (var i = 0; i < texts.length; i += MODEL_BATCH) {
      var batch = texts.slice(i, i + MODEL_BATCH);
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

function getWorker(): Worker {
  if (worker) return worker;

  const modelsDir = path.join(app.getPath('userData'), 'models');

  worker = new Worker(EMBEDDER_WORKER_CODE, {
    eval: true,
    workerData: { modelsDir, resolveDir: __dirname },
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
  });

  try { writeLog('embedder:spawned', 'Worker spawned'); } catch { /* ignore */ }

  worker.on('message', (msg: { id: number; type: string; vectors?: number[][]; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.error));
    else p.resolve(msg.vectors ?? []);
  });

  worker.on('error', (err: unknown) => {
    try { writeLog('embedder:ERROR', `Worker crashed: ${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ }
    const error = err instanceof Error ? err : new Error(String(err));
    for (const [, p] of pending) p.reject(error);
    pending.clear();
    worker = null;
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      try { writeLog('embedder:ERROR', `Worker exited code:${code}`); } catch { /* ignore */ }
    }
    // Reject any tasks that are still pending (e.g. worker exited before sending a response)
    if (pending.size > 0) {
      const exitError = new Error(`Embedder worker exited unexpectedly (code ${code})`);
      for (const [, p] of pending) p.reject(exitError);
      pending.clear();
    }
    worker = null;
  });

  return worker;
}

// ── Public API (same surface as before) ──────────────────────────────────────

/** Warm up the worker and model. Safe to call multiple times. */
export async function initEmbedder(): Promise<void> {
  getWorker();
}

/** Warm up the worker by sending a warmup message that triggers model loading. */
export async function warmup(): Promise<void> {
  const w = getWorker();
  const id = reqId++;
  return new Promise<void>((resolve, reject) => {
    pending.set(id, {
      resolve: () => resolve(),
      reject,
    });
    w.postMessage({ id, type: 'warmup' });
  });
}

/** Embed a single string → 384-dim vector (runs in worker thread). */
export async function embed(text: string): Promise<number[]> {
  try {
    const [vec] = await embedBatch([text]);
    return vec;
  } catch {
    console.warn('[embedder] Failed to embed text, using zero vector');
    return ZERO_VEC;
  }
}

/**
 * Embed many strings using true batch inference in a worker thread.
 * The model processes up to 64 texts at once (much faster than one-by-one).
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const w = getWorker();
  const id = reqId++;
  try { writeLog('embedder:task', `Worker task id:${id} texts:${texts.length}`, true); } catch { /* ignore */ }
  const t = Date.now();
  return new Promise<number[][]>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => {
        try { writeLog('embedder:task', `Worker task id:${id} in ${Date.now() - t}ms`, true); } catch { /* ignore */ }
        try { writeLog('embedder:queue', `length:${pending.size} idle:${pending.size === 0 ? 1 : 0}`, true); } catch { /* ignore */ }
        resolve(v);
      },
      reject,
    });
    w.postMessage({ id, texts });
  });
}
