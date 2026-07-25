import { notFound } from './ApiError.js';
import type { JsonResponse, Revisioned } from './HttpContract.js';

export function resultResponse<T>(
  result: Revisioned<T> | null,
  status = 200,
  resource = 'Resource',
): JsonResponse {
  if (!result) throw notFound(resource);
  return {
    status,
    body: result,
    revision: result.revision,
  };
}
