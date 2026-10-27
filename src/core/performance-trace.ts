import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const diagnosticStages = ['action', 'dispatch', 'acknowledge', 'settings', 'history', 'render', 'snapshot', 'payload', 'send', 'finalize', 'lookup', 'parse', 'review', 'validate', 'submit', 'save', 'saved-state', 'duplicate-check', 'cloud-history', 'local-history', 'hydration', 'comparison', 'chart', 'bind', 'reply', 'auto-share', 'diagnostic', 'notice', 'ocr-cloud', 'ocr-local', 'unknown'] as const;
export type DiagnosticStage = typeof diagnosticStages[number];
const stageSet = new Set<string>(diagnosticStages);
const flowSalt = randomBytes(32);
const failureStages = new WeakMap<object, DiagnosticStage>();

type Span = 'tracker-settings' | 'shared-settings' | 'history-view' | 'summary' | 'comparison' | 'chart'
  | 'cloud-identity' | 'cloud-main' | 'cloud-count' | 'cloud-extended' | 'cloud-stitch'
  | 'history-snapshot' | 'coalesced-history-wait' | 'cloud-capacity-wait' | 'cloud-sdk' | 'ocr-cloud' | 'ocr-local';
type Samples = { count: number; pending: number; totalMs: number; maxMs: number; samples: number[] };
type Trace = { operationId: string; spans: Partial<Record<Span, Samples>>; stage?: DiagnosticStage; flowRef?: string; flowMode?: 'track' | 'lifetime'; failed?: boolean };
type SpanSummary = { count: number; pending: number; totalMs: number; maxMs: number; sampled: number; p50Ms: number | null; p95Ms: number | null };
const traces = new AsyncLocalStorage<Trace>();
const MAX_SAMPLES = 256;

/** Opaque operation IDs only: no owners, request paths, document IDs or payloads. */
export function withPerformanceTrace<T>(action: () => Promise<T>): Promise<T> {
  return traces.run({ operationId: randomUUID(), spans: {} }, action);
}
export function ensurePerformanceTrace<T>(action: () => Promise<T>): Promise<T> {
  return traces.getStore() ? action() : withPerformanceTrace(action);
}
export function isDiagnosticStage(stage: unknown): stage is DiagnosticStage { return typeof stage === 'string' && stageSet.has(stage); }
export function setPerformanceTraceStage(stage: string): void { const trace = traces.getStore(); if (trace) trace.stage = isDiagnosticStage(stage) ? stage : 'unknown'; }
export function bindPerformanceFlow(token: string, mode?: string): void {
  const trace = traces.getStore(); if (!trace) return;
  trace.flowRef = createHmac('sha256', flowSalt).update(token).digest('hex').slice(0, 24);
  if (mode === 'track' || mode === 'lifetime') trace.flowMode = mode;
}
export function markPerformanceFailure(): void { const trace = traces.getStore(); if (trace) trace.failed = true; }
export function rememberPerformanceErrorStage(error: unknown): void {
  const stage = traces.getStore()?.stage;
  if (error && typeof error === 'object' && stage && !failureStages.has(error)) failureStages.set(error, stage);
}
export function readPerformanceErrorStage(error: unknown): DiagnosticStage | undefined { return error && typeof error === 'object' ? failureStages.get(error) : undefined; }
export function performanceDiagnosticContext(): { operationId?: string; pid?: number; diagnosticStage?: DiagnosticStage; flowRef?: string; flowMode?: 'track' | 'lifetime'; handledFailure?: boolean } {
  const trace = traces.getStore();
  return trace ? { ...performanceTraceIdentity(), diagnosticStage: trace.stage ?? 'action',
    ...(trace.flowRef ? { flowRef: trace.flowRef } : {}), ...(trace.flowMode ? { flowMode: trace.flowMode } : {}), handledFailure: trace.failed === true } : {};
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
