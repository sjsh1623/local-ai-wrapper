import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

const routeSchema = z.object({
  match: z.record(z.string()),
  repo: z.string(),
  base: z.string().optional(),
  verify: z.array(z.string()).default([]),
  pr: z
    .object({
      draft: z.boolean().default(true),
      labels: z.array(z.string()).default([]),
      reviewers: z.array(z.string()).default([]),
      title: z.string().optional(),
    })
    .default({ draft: true, labels: [], reviewers: [] }),
});

const fileSchema = z.object({ routes: z.array(routeSchema).default([]) });

export type Route = z.infer<typeof routeSchema>;

let routes: Route[] = [];

export function loadRoutes(): Route[] {
  const cfg = getConfig();
  try {
    const parsed = fileSchema.safeParse(parse(readFileSync(cfg.routesFile, 'utf8')));
    if (!parsed.success) {
      logger.error({ file: cfg.routesFile, issues: parsed.error.issues }, 'routes file is invalid, ignoring it');
      routes = [];
      return routes;
    }
    routes = parsed.data.routes;
    logger.info({ file: cfg.routesFile, count: routes.length }, 'routes loaded');
  } catch (err) {
    // A missing routes file is fine — label-driven routing is the primary path.
    logger.info({ file: cfg.routesFile, err: String(err) }, 'no routes file; using labels only');
    routes = [];
  }
  return routes;
}

/** First route whose every `match` entry equals the alert's label. */
export function matchRoute(labels: Record<string, string>): Route | null {
  for (const route of routes) {
    const hit = Object.entries(route.match).every(([k, v]) => labels[k] === v);
    if (hit) return route;
  }
  return null;
}
