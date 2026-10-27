import { logger } from './logger';
import { ensurePerformanceTrace, markPerformanceFailure, performanceDiagnosticContext, rememberPerformanceErrorStage, setPerformanceTraceStage } from './performance-trace';

/** Fixed labels only. Existing logger throttling bounds start/finish records during outages. */
export function observeOperation<T>(kind: 'interaction' | 'submission' | 'ocr', action: () => Promise<T>): Promise<T> {
  return ensurePerformanceTrace(async () => {
    const started = performance.now();
    setPerformanceTraceStage(kind === 'interaction' ? 'dispatch' : kind === 'ocr' ? 'ocr-cloud' : 'review');
    logger.warn('[diag] operation.start', { kind, ...performanceDiagnosticContext() });
    let failed = false;
    try { return await action(); }
    catch (error) { failed = true; rememberPerformanceErrorStage(error); markPerformanceFailure(); throw error; }
    finally { logger.warn('[diag] operation.finish', { kind, ...performanceDiagnosticContext(), rejected: failed, durationMs: Math.round(performance.now() - started) }); }
  });
}
