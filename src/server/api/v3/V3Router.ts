import type { IncomingMessage, ServerResponse } from 'node:http';
import { V3ApiError } from './ApiError.js';
import type { V3ApiServices } from './Contracts.js';
import { sendJson, sendV3Error } from './HttpContract.js';
import { matchV3Route, type V3Route } from './Route.js';
import { companyRoutes } from './routes/CompanyRoutes.js';
import { workRoutes } from './routes/WorkRoutes.js';

export interface V3Router {
  readonly routes: readonly V3Route[];
  /**
   * Handle a v3 request. Returns false without writing a response when the URL
   * is outside /api/v3 so an owning raw-node-http server can continue routing.
   */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export function createV3Router(services: V3ApiServices): V3Router {
  const routes = Object.freeze([
    ...companyRoutes(services.company),
    ...workRoutes(services.work),
  ]);

  return {
    routes,
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      let url: URL;
      try {
        url = requestUrl(req);
      } catch (error) {
        sendV3Error(res, error);
        return true;
      }
      if (!url.pathname.startsWith('/api/v3/') && url.pathname !== '/api/v3') return false;

      const method = (req.method || 'GET').toUpperCase();
      const matched = matchV3Route(routes, method, url.pathname);
      if (!matched) {
        const pathExists = routes.some((route) => matchV3Route([route], route.method, url.pathname));
        sendV3Error(
          res,
          pathExists
            ? new V3ApiError(405, 'bad_request', `Method ${method} is not allowed for this resource`)
            : new V3ApiError(404, 'not_found', 'Route not found'),
        );
        return true;
      }

      try {
        const response = await matched.route.handle({
          req,
          res,
          url,
          params: matched.params,
        });
        sendJson(res, response);
      } catch (error) {
        sendV3Error(res, error);
      }
      return true;
    },
  };
}

function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    throw new V3ApiError(400, 'bad_request', 'Request URL is invalid');
  }
}
