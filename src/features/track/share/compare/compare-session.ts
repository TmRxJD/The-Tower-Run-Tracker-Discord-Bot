import { randomBytes } from 'node:crypto';
import { TransientCache } from '../../../../core/transient-cache';
import { type ShareEmbedInput } from '../share-embed';
import { type CompareChoice, type CompareShared } from './compare-data';
import type { ComparePage } from './compare-rows';

export const COMPARE_TTL_MS = 5 * 60_000;
export interface CompareSession {
  token: string; ownerId: string; sourceKey: string; messageId?: string;
  expiresAt: number; revision: number; page: number; busy: boolean;
  shared: CompareShared; options: NonNullable<ShareEmbedInput['options']>;
  choices: CompareChoice[]; recentOnly: boolean;
  canCompareReports?: boolean;
  view?: 'picker' | 'details' | 'reports';
  detailPage?: number;
  reportPage?: number;
  selected?: { choice: CompareChoice; run: Record<string, unknown>; name: string; details: ComparePage[];
    reports?: { pages: ComparePage[]; sharedAvailable: boolean; mineAvailable: boolean } };
}
const sessions = new TransientCache<string, CompareSession>(256, COMPARE_TTL_MS);
const active = new TransientCache<string, { token: string; expiresAt: number }>(256, COMPARE_TTL_MS);

export function beginCompare(sourceKey: string): string | null {
  const previous = active.get(sourceKey);
  if (previous && previous.expiresAt > Date.now() && (!sessions.has(previous.token) || getCompareSession(previous.token))) return null;
  const token = randomBytes(12).toString('hex');
  active.set(sourceKey, { token, expiresAt: Date.now() + COMPARE_TTL_MS });
  return token;
}
export function saveCompareSession(session: CompareSession): void { sessions.set(session.token, session); }
export function getCompareSession(token: string): CompareSession | undefined {
  const session = sessions.get(token);
  if (session && session.expiresAt <= Date.now()) { endCompare(token, session.sourceKey); return undefined; }
  return session;
}
export function endCompare(token: string, sourceKey: string): void {
  sessions.delete(token);
  if (active.get(sourceKey)?.token === token) active.delete(sourceKey);
}
export function compareStillActive(session: CompareSession): boolean { return getCompareSession(session.token) === session; }
