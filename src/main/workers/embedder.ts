import { app } from 'electron';
import * as path from 'path';

// @xenova/transformers ships ESM; require-interop via CommonJS dynamic require
// is unreliable in webpack, so we use dynamic import() at runtime.
type PipelineType = (
  task: string,
  model: string,
  options?: Record<string, unknown>,
) => Promise<(text: string | string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array }>>;

let extractor: Awaited<ReturnType<PipelineType>> | null = null;

/**
 * Download / load from cache the all-MiniLM-L6-v2 model.
 * Safe to call multiple times — returns immediately if already initialised.
 */
export async function initEmbedder(): Promise<void> {
  if (extractor) return;

  const modelsDir = path.join(app.getPath('userData'), 'models');
  console.log('[embedder] Loading model, cache dir:', modelsDir);

  // Dynamic import allows webpack to tree-shake ESM interop at build time
  const { pipeline, env } = await import('@xenova/transformers');
  (env as { cacheDir: string }).cacheDir = modelsDir;

  extractor = await (pipeline as unknown as PipelineType)(
    'feature-extraction',
    'Xenova/all-MiniLM-L6-v2',
    { progress_callback: (p: { status: string; progress?: number }) => {
        if (p.status === 'progress') {
          process.stdout.write(`\r[embedder] Downloading model: ${(p.progress ?? 0).toFixed(1)}%`);
        } else if (p.status === 'done') {
          console.log('\n[embedder] Model ready.');
        }
      },
    },
  );
}

/** Embed a single string → 384-dim Float32Array */
export async function embed(text: string): Promise<number[]> {
  if (!extractor) await initEmbedder();
  const output = await extractor!(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/** Embed many strings in batches of `batchSize` to prevent OOM */
export async function embedBatch(texts: string[], batchSize = 8): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await Promise.all(batch.map(embed));
    results.push(...vectors);
  }
  return results;
}
