import { ImportOptions, ImportProgress, ImportResult } from './types';
import { runImportPipeline } from './pipeline';

export async function runImportPipelineWithProgress(
  input: string | Record<string, any>[],
  options: ImportOptions = {},
  onProgress: (progress: ImportProgress) => void,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const effectiveSignal = options.signal || signal;

  const total = typeof input === 'string'
    ? Math.max(0, input.trim().split(/\r?\n/).length - 1)
    : input.length;

  if (effectiveSignal?.aborted) {
    const cancelledResult = runImportPipeline(input, {
      ...options,
      signal: effectiveSignal,
    });
    return cancelledResult;
  }

  const result = runImportPipeline(input, {
    ...options,
    signal: effectiveSignal,
    onProgress: (prog) => {
      onProgress(prog);
      if (options.onProgress) {
        options.onProgress(prog);
      }
    },
  });

  onProgress({
    processed: result.summary.totalRows,
    total: result.summary.totalRows,
    errors: result.summary.errorCount,
  });

  return result;
}

