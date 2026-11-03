import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { closeBrowser } from './browser.js';
import { scrapeKuramanime } from './scrapers/kuramanime.js';
import { type ApiResponse, type ScrapeResult, ScraperError } from './types.js';

const app = new Hono();

// Middleware logger
app.use('*', logger());

// Root endpoint: Info microservice
app.get('/', (c) => {
  return c.json({
    name: 'kuzen-worker',
    description: 'Headless video stream scraper microservice for Kuramanime',
    endpoints: {
      health: 'GET /health',
      stream: 'GET /api/kuramanime/stream?url={encodedEpisodeUrl}&server={optionalServer}',
      watch: 'GET /api/kuramanime/watch?url={encodedEpisodeUrl}&server={optionalServer}',
    },
  });
});

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Handler bersama untuk streaming & watch Kuramanime
const handleKuramanimeWatch = async (c: any) => {
  const targetUrl = c.req.query('url');
  const server = c.req.query('server');

  if (!targetUrl) {
    const errorResponse: ApiResponse<never> = {
      status: 'error',
      message: 'Query parameter "url" is required.',
      code: 'MISSING_URL_PARAM',
    };
    return c.json(errorResponse, 400);
  }

  try {
    const decodedUrl = decodeURIComponent(targetUrl);
    console.log(`[API] Processing stream extraction for: ${decodedUrl}`);

    const result = await scrapeKuramanime({
      url: decodedUrl,
      server: server ? decodeURIComponent(server) : undefined,
      timeoutMs: 25_000,
    });

    const successResponse: ApiResponse<ScrapeResult> = {
      status: 'success',
      data: result,
    };

    return c.json(successResponse, 200);
  } catch (err: unknown) {
    console.error('[API Error]', err);

    if (err instanceof ScraperError) {
      const errorResponse: ApiResponse<never> = {
        status: 'error',
        message: err.message,
        code: err.code,
      };
      return c.json(errorResponse, err.statusCode as any);
    }

    const message = err instanceof Error ? err.message : 'An unexpected error occurred';
    const errorResponse: ApiResponse<never> = {
      status: 'error',
      message,
      code: 'INTERNAL_SERVER_ERROR',
    };
    return c.json(errorResponse, 500);
  }
};

// Kuramanime stream & watch endpoints (kompatibel penuh dengan standar api_kuzen)
app.get('/api/kuramanime/stream', handleKuramanimeWatch);
app.get('/api/kuramanime/watch', handleKuramanimeWatch);

// Tangani route 404
app.notFound((c) => {
  return c.json(
    {
      status: 'error',
      message: 'Endpoint not found',
      code: 'NOT_FOUND',
    },
    404
  );
});

const port = Number(process.env.PORT) || 3000;
const hostname = process.env.HOST || '0.0.0.0';
console.log(`[Server] Starting kuzen_worker microservice on ${hostname}:${port}...`);

const serverInstance = serve({
  fetch: app.fetch,
  port,
  hostname,
});

// Graceful shutdown handling
const cleanup = async () => {
  console.log('[Server] Gracefully shutting down...');
  await closeBrowser();
  serverInstance.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

