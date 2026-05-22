import type { ConfigController } from './config.controller';
import type { NoteController } from './note.controller';
import type { ScanController } from './scan.controller';
import type { ThemeController } from './theme.controller';

export type RouteHandler = (req: Request, params?: Record<string, string>) => Promise<Response>;

export interface Route {
  method: string;
  path: string | RegExp;
  handler: RouteHandler;
}

function matchPath(path: string, pattern: string | RegExp): Record<string, string> | null {
  if (typeof pattern === 'string') {
    return path === pattern ? {} : null;
  }
  const match = path.match(pattern);
  if (!match) return null;
  return { id: match[1] ?? '', noteId: match[2] ?? '' };
}

export function createRouter(
  noteController: NoteController,
  scanController: ScanController,
  configController: ConfigController,
  themeController: ThemeController,
  getProviders: () => { active: string | null; available: string[] },
): (req: Request) => Promise<Response> {
  const routes: Route[] = [
    {
      method: 'POST',
      path: '/notes',
      handler: (req) => noteController.create(req),
    },
    {
      method: 'POST',
      path: '/notes/batch',
      handler: (req) => noteController.createBatch(req),
    },
    {
      method: 'POST',
      path: '/notes/retry-failed',
      handler: () => noteController.retryFailed(),
    },
    {
      method: 'GET',
      path: '/notes',
      handler: () => noteController.list(),
    },
    {
      method: 'GET',
      path: /^\/notes\/([^/]+)$/,
      handler: (_req, params) => noteController.get(params?.id ?? ''),
    },
    {
      method: 'PUT',
      path: /^\/notes\/([^/]+)$/,
      handler: (req, params) => noteController.edit(params?.id ?? '', req),
    },
    {
      method: 'DELETE',
      path: /^\/notes\/([^/]+)$/,
      handler: (_req, params) => noteController.delete(params?.id ?? ''),
    },
    {
      method: 'GET',
      path: '/themes',
      handler: () => themeController.list(),
    },
    {
      method: 'POST',
      path: '/themes',
      handler: (req) => themeController.create(req),
    },
    {
      method: 'DELETE',
      path: /^\/themes\/([^/]+)$/,
      handler: (_req, params) => themeController.delete(params?.id ?? ''),
    },
    {
      method: 'PUT',
      path: /^\/themes\/([^/]+)$/,
      handler: (req, params) => themeController.update(params?.id ?? '', req),
    },
    {
      method: 'POST',
      path: '/themes/merge',
      handler: (req) => themeController.merge(req),
    },
    {
      method: 'POST',
      path: /^\/themes\/([^/]+)\/notes\/([^/]+)$/,
      handler: (_req, params) => themeController.assignNote(params?.id ?? '', params?.noteId ?? ''),
    },
    {
      method: 'DELETE',
      path: /^\/themes\/([^/]+)\/notes\/([^/]+)$/,
      handler: (_req, params) =>
        themeController.unassignNote(params?.id ?? '', params?.noteId ?? ''),
    },
    {
      method: 'GET',
      path: '/scan/status',
      handler: () => scanController.getStatus(),
    },
    {
      method: 'POST',
      path: '/scan/classify',
      handler: () => scanController.runClassify(),
    },
    {
      method: 'POST',
      path: '/scan/classify/commit',
      handler: (req) => scanController.commitClassify(req),
    },
    {
      method: 'POST',
      path: '/scan/organize',
      handler: () => scanController.runOrganize(),
    },
    {
      method: 'POST',
      path: '/scan/organize/commit',
      handler: (req) => scanController.commitOrganize(req),
    },
    {
      method: 'POST',
      path: '/scan/graph',
      handler: () => scanController.runGraph(),
    },
    {
      method: 'POST',
      path: '/scan/consolidate',
      handler: () => scanController.runConsolidate(),
    },
    {
      method: 'POST',
      path: '/scan/consolidate/commit',
      handler: (req) => scanController.commitConsolidate(req),
    },
    {
      method: 'GET',
      path: '/config',
      handler: () => configController.getConfig(),
    },
    {
      method: 'PUT',
      path: '/config',
      handler: (req) => configController.updateConfig(req),
    },
    {
      method: 'POST',
      path: '/reset',
      handler: (req) => configController.reset(req),
    },
    {
      method: 'GET',
      path: '/calibration',
      handler: () => scanController.getCalibration(),
    },
    {
      method: 'GET',
      path: '/providers',
      handler: () => {
        const data = getProviders();
        return Promise.resolve(
          new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    },
    {
      method: 'GET',
      path: '/health',
      handler: () => Promise.resolve(new Response('OK')),
    },
  ];

  return async (req: Request) => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    for (const route of routes) {
      const params = matchPath(pathname, route.path);
      if (req.method === route.method && params !== null) {
        return route.handler(req, Object.keys(params).length > 0 ? params : undefined);
      }
    }

    return new Response('Not Found', { status: 404 });
  };
}
