type AppwriteErrorLike = {
  code?: unknown;
  status?: unknown;
  type?: unknown;
  message?: unknown;
};

type AppwriteErrorDetails = {
  code: number | null;
  status: number | null;
  type: string;
  message: string;
};

export function getAppwriteErrorDetails(error: unknown): AppwriteErrorDetails | null {
  if (!error || typeof error !== 'object') return null;

  const source = error as AppwriteErrorLike;
  return {
    code: typeof source.code === 'number' ? source.code : null,
    status: typeof source.status === 'number' ? source.status : null,
    type: typeof source.type === 'string' ? source.type.toLowerCase() : '',
    message: typeof source.message === 'string' ? source.message.toLowerCase() : '',
  };
}

export function isUnauthorizedAppwriteError(error: unknown): boolean {
  const details = getAppwriteErrorDetails(error);
  if (!details) return false;

  return details.code === 401
    || details.code === 403
    || details.status === 401
    || details.status === 403
    || details.type.includes('unauthorized')
    || details.type === 'user_unauthorized'
    || details.message.includes('unauthorized')
    || details.message.includes('forbidden')
    || details.message.includes('not authorized');
}

export function isNotFoundAppwriteError(error: unknown): boolean {
  const details = getAppwriteErrorDetails(error);
  if (!details) return false;

  return details.code === 404
    || details.status === 404
    || details.type.includes('not_found')
    || details.type.includes('not found')
    || details.message.includes('not found');
}
