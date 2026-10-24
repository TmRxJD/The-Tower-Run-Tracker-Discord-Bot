import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

type Span = 'tracker-settings' | 'shared-settings' | 'history-view' | 'summary' | 'comparison' | 'chart'
  | 'cloud-identity' | 'cloud-main' | 'cloud-count' | 'cloud-extended' | 'cloud-stitch'
  | 'history-snapshot' | 'coalesced-history-wait' | 'cloud-capacity-wait' | 'cloud-sdk';
type Samples = { count: number; pending: number; totalMs: number; maxMs: number; samples: number[] };
type Trace = { operationId: string; spans: Partial<Record<Span, Samples>> };
type SpanSummary = { count: number; pending: number; totalMs: number; maxMs: number; sampled: number; p50Ms: number | null; p95Ms: number | null };
const traces = new AsyncLocalStorage<Trace>();
const MAX_SAMPLES = 256;

/** Opaque operation IDs only: no owners, request paths, document IDs or payloads. */
export function withPerformanceTrace<T>(action: () => Promise<T>): Promise<T> {
  return traces.run({ operationId: randomUUID(), spans: {} }, action);
}
export function performanceTraceIdentity(): { operationId?: string; pid?: number } {
  const trace = traces.getStore();
  return trace ? { operationId: trace.operationId, pid: process.pid } : {};
}
function startSpan(trace: Trace, name: Span) {
  const values = trace.spans[name] ??= { count: 0, pending: 0, totalMs: 0, maxMs: 0, samples: [] };
  values.pending++;
  return values;
}
function recordSpan(values: Samples, started: number) {
  const ms = performance.now() - started;
  values.pending--;
  values.count++; values.totalMs += ms; values.maxMs = Math.max(values.maxMs, ms);
  if (values.samples.length < MAX_SAMPLES) values.samples.push(ms);
}
export async function measurePerformanceSpan<T>(name: Span, action: () => Promise<T>): Promise<T> {
  const trace = traces.getStore();
  if (!trace) return action();
  const values = startSpan(trace, name);
  const started = performance.now();
  try { return await action(); } finally { recordSpan(values, started); }
}
export function measurePerformanceSync<T>(name: Span, action: () => T): T {
  const trace = traces.getStore();
  if (!trace) return action();
  const values = startSpan(trace, name);
  const started = performance.now();
  try { return action(); } finally { recordSpan(values, started); }
}
export function performanceTraceSummary(): { operationId?: string; pid?: number; spans?: Partial<Record<Span, SpanSummary>> } {
  const trace = traces.getStore();
  if (!trace) return {};
  return { ...performanceTraceIdentity(), spans: Object.fromEntries(Object.entries(trace.spans).map(([name, values]) => {
    const samples = [...values.samples].sort((a, b) => a - b);
    return [name, { count: values.count, pending: values.pending, totalMs: Math.round(values.totalMs), maxMs: Math.round(values.maxMs),
      sampled: samples.length, p50Ms: samples.length ? Math.round(samples[Math.ceil(samples.length * .5) - 1]) : null,
      p95Ms: samples.length ? Math.round(samples[Math.ceil(samples.length * .95) - 1]) : null }];
  })) };
}
