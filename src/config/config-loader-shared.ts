import { getAppConfig } from './index';

type ConfigDocument = {
  version: string;
  payload: string;
};

type CachedConfig<TPayload> = {
  version: string;
  payload: TPayload;
};

export async function loadCachedJsonConfig<TPayload extends Record<string, unknown>>(
  cache: Map<string, CachedConfig<TPayload>>,
  readDocument: (env: string) => Promise<ConfigDocument | null>,
): Promise<TPayload | null> {
  const env = getAppConfig().deploymentMode;
  const doc = await readDocument(env);
  if (!doc) return null;

  const cached = cache.get(env);
  if (cached && cached.version === doc.version) {
    return cached.payload;
  }

  try {
    const parsed = JSON.parse(doc.payload) as TPayload;
    cache.set(env, { version: doc.version, payload: parsed });
    return parsed;
  } catch (error) {
    cache.delete(env);
    throw error;
  }
}
