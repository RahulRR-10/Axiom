import { app } from 'electron';
import * as path from 'path';
import { Worker } from 'worker_threads';

// ── Persistent worker thread for embedding ───────────────────────────────────
// All ONNX model inference runs off the main thread so the UI never blocks.
// The worker loads the model once and processes batched requests via messages.

const DIM = 384; // all-MiniLM-L6-v2 output dimension
const ZERO_VEC: number[] = new Array(DIM).fill(0);

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();

// ── Worker source (plain JS — runs in its own V8 isolate) ────────────────────
const EMBEDDER_WORKER_CODE = String.raw`
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { createRequire } = require('module');

let extractor = null;

async function init() {
  if (extractor) return;
  const localRequire = createRequire(workerData.resolveDir + '/package.json');
  const transformers = localRequire('@xenova/transformers');
  const pipeline = transformers.pipeline;
  const env = transformers.env;
  if (env) env.cacheDir = workerData.modelsDir;
  extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true,
    progress_callback: function() {},
  });
}

parentPort.on('message', async function(msg) {
  try {
    await init();
    var texts = msg.texts;
    var dim = ${DIM};
    var MODEL_BATCH = 64;
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
  });

  worker.on('message', (msg: { id: number; type: string; vectors?: number[][]; error?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.error));
    else p.resolve(msg.vectors ?? []);
  });

  worker.on('error', (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    for (const [, p] of pending) p.reject(error);
    pending.clear();
    worker = null;
  });

  worker.on('exit', () => { worker = null; });

  return worker;
}

// ── Public API (same surface as before) ──────────────────────────────────────

/** Warm up the worker and model. Safe to call multiple times. */
export async function initEmbedder(): Promise<void> {
  getWorker();
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
  return new Promise<number[][]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, texts });
  });
}
