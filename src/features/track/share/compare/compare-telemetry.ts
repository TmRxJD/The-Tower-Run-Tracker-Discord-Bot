import { logger } from '../../../../core/logger';

export type CompareAction = 'open' | 'select' | 'previous' | 'next' | 'back' | 'cancel' | 'reports' | 'details';
type Stage = 'authorize' | 'acknowledge' | 'snapshot' | 'access' | 'choices' | 'picker' | 'run-read' | 'render' | 'reply';
type Outcome = 'picker_delivered' | 'comparison_delivered' | 'closed' | 'no_runs' | 'unlinked' | 'snapshot_unavailable'
  | 'run_unavailable' | 'report_delivered' | 'report_unavailable' | 'rejected' | 'already_open' | 'stale_control' | 'cancelled_or_expired' | 'ack_failed' | 'failed';

/** One bounded content-free record; successful delivery means the private edit request resolved. */
export function createCompareObservation(action: CompareAction) {
  const started = performance.now();
  let stage: Stage = 'authorize';
  let outcome: Outcome = 'failed';
  let code: number | undefined;
  return {
    stage(value: Stage) { stage = value; },
    outcome(value: Outcome) { outcome = value; },
    failure(error: unknown, value: 'failed' | 'ack_failed' = 'failed') {
      outcome = value;
      const candidate = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      code = typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 10000 && candidate <= 59999 ? candidate : undefined;
    },
    finish() {
      logger.warn('[share-compare] interaction', { pid: process.pid, action, outcome, stage,
        durationMs: Math.max(0, Math.round(performance.now() - started)), ...(code === undefined ? {} : { code }) });
    },
  };
}
export type CompareObservation = ReturnType<typeof createCompareObservation>;
