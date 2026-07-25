import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonResponse } from './HttpContract.js';

export type V3HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface V3RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Readonly<Record<string, string>>;
}

export interface V3Route {
  method: V3HttpMethod;
  path: string;
  handle(context: V3RouteContext): Promise<JsonResponse>;
}

export interface MatchedV3Route {
  route: V3Route;
  params: Record<string, string>;
}

export function matchV3Route(
  routes: readonly V3Route[],
  method: string,
  pathname: string,
): MatchedV3Route | undefined {
  const pathSegments = splitPath(pathname);
  for (const route of routes) {
    if (route.method !== method) continue;
    const patternSegments = splitPath(route.path);
    if (patternSegments.length !== pathSegments.length) continue;

    const params: Record<string, string> = {};
    let matches = true;
    for (let index = 0; index < patternSegments.length; index += 1) {
      const pattern = patternSegments[index];
      const actual = pathSegments[index];
      if (pattern.startsWith(':')) {
        try {
          const decoded = decodeURIComponent(actual);
          if (!decoded || decoded.includes('/')) {
            matches = false;
            break;
          }
          params[pattern.slice(1)] = decoded;
        } catch {
          matches = false;
          break;
        }
      } else if (pattern !== actual) {
        matches = false;
        break;
      }
    }
    if (matches) return { route, params };
  }
  return undefined;
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}
