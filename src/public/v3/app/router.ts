import { useEffect, useState } from 'preact/hooks';
import type { ShellRoute } from '../model.js';

const ROUTES = new Set<ShellRoute>(['work', 'company', 'settings']);

export function useShellRoute(): [ShellRoute, (route: ShellRoute) => void] {
  const [route, setRoute] = useState<ShellRoute>(readRoute);

  useEffect(() => {
    const handleHashChange = () => setRoute(readRoute());
    addEventListener('hashchange', handleHashChange);
    return () => removeEventListener('hashchange', handleHashChange);
  }, []);

  return [route, (next) => {
    if (next === route) return;
    location.hash = next;
  }];
}

function readRoute(): ShellRoute {
  const route = location.hash.replace(/^#\/?/, '') as ShellRoute;
  return ROUTES.has(route) ? route : 'work';
}
