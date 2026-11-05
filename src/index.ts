import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { closeBrowser } from './browser.js';
import { scrapeKuramanime } from './scrapers/kuramanime.js';
import {
  scrapeLk21Detail,
  scrapeLk21Latest,
  scrapeLk21Search,
  scrapeLk21Stream,
} from './scrapers/lk21.js';
import {
  scrapeIdlixDetail,
  scrapeIdlixLatest,
  scrapeIdlixSearch,
  scrapeIdlixStream,
} from './scrapers/idlix.js';
import { type ApiResponse, type ScrapeResult, ScraperError } from './types.js';

const app = new Hono();

// Middleware
app.use('*', cors());
app.use('*', logger());

// Helper penanganan error konsisten
const handleError = (c: any, err: unknown) => {
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
};

// Root endpoint: Info microservice & dokumentasi endpoint
app.get('/', (c) => {
  return c.json({
    name: 'kuzen-worker',
    description: 'Headless scraper microservice for Kuramanime, LK21, and IDLIX (Full api_kuzen & kuzen_app compatibility)',
    version: '1.1.0',
    endpoints: {
      health: 'GET /health',
      kuramanime: {
        stream: 'GET /api/kuramanime/stream?url={encodedEpisodeUrl}&server={optionalServer}',
        watch: 'GET /api/kuramanime/watch?url={encodedEpisodeUrl}&server={optionalServer}',
      },
      lk21: {
        home: 'GET /api/lk21/home (atau /api/lk21/latest?page=1)',
        search: 'GET /api/lk21/search?q={keyword}&page=1',
        movie: 'GET /api/lk21/movie/:slug (atau /api/lk21/detail?url={url})',
        watch: 'GET /api/lk21/watch/:slug (atau /api/lk21/stream?url={url})',
      },
      idlix: {
        home: 'GET /api/idlix/home (atau /api/idlix/latest?page=1&type=movie|series)',
        search: 'GET /api/idlix/search?q={keyword}&page=1',
        movie: 'GET /api/idlix/movie/:slug (atau /api/idlix/detail?url={url})',
        series: 'GET /api/idlix/series/:slug',
        watch: 'GET /api/idlix/watch/:slug (atau /api/idlix/stream?url={url})',
      },
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

/* ========================================================================= */
/*                          KURAMANIME ENDPOINTS                             */
/* ========================================================================= */

const handleKuramanimeWatch = async (c: any) => {
  const targetUrl = c.req.query('url');
  const server = c.req.query('server');

  if (!targetUrl) {
    return c.json(
      {
        status: 'error',
        message: 'Query parameter "url" is required.',
        code: 'MISSING_URL_PARAM',
      },
      400
    );
  }

  try {
    const decodedUrl = decodeURIComponent(targetUrl);
    console.log(`[API] Processing Kuramanime stream extraction for: ${decodedUrl}`);

    const result = await scrapeKuramanime({
      url: decodedUrl,
      server: server ? decodeURIComponent(server) : undefined,
      timeoutMs: 25_000,
    });

    return c.json({ status: 'success', data: result }, 200);
  } catch (err) {
    return handleError(c, err);
  }
};

app.get('/api/kuramanime/stream', handleKuramanimeWatch);
app.get('/api/kuramanime/watch', handleKuramanimeWatch);

/* ========================================================================= */
/*                              LK21 ENDPOINTS                               */
/* ========================================================================= */

// Handler Home / Latest LK21 (Format data: [] langsung kompatibel api_kuzen & kuzen_app)
const handleLk21Latest = async (c: any) => {
  const page = Number(c.req.query('page')) || 1;
  const baseUrl = c.req.query('base');

  try {
    const result = await scrapeLk21Latest(page, baseUrl);
    return c.json({
      status: 'success',
      data: result.items,
      page: result.page,
      hasMore: result.hasMore,
    });
  } catch (err) {
    return handleError(c, err);
  }
};

app.get('/api/lk21/home', handleLk21Latest);
app.get('/api/lk21/latest', handleLk21Latest);

// Handler Search LK21
app.get('/api/lk21/search', async (c) => {
  const query = c.req.query('q');
  const page = Number(c.req.query('page')) || 1;
  const baseUrl = c.req.query('base');

  if (!query) {
    return c.json(
      {
        status: 'error',
        message: 'Query parameter "q" is required.',
        code: 'MISSING_QUERY',
      },
      400
    );
  }

  try {
    const result = await scrapeLk21Search(query, page, baseUrl);
    return c.json({
      status: 'success',
      data: result.items,
      page: result.page,
      hasMore: result.hasMore,
    });
  } catch (err) {
    return handleError(c, err);
  }
});

// Handler Detail LK21 (Bisa via :slug maupun query ?url=)
const handleLk21Detail = async (c: any) => {
  const slug = c.req.param('slug');
  const targetUrl = c.req.query('url');
  const input = slug || (targetUrl ? decodeURIComponent(targetUrl) : '');
  const baseUrl = c.req.query('base');

  if (!input) {
    return c.json(
      {
        status: 'error',
        message: 'Parameter "slug" or query "url" is required.',
        code: 'MISSING_TARGET_PARAM',
      },
      400
    );
  }

  try {
    const result = await scrapeLk21Detail(input, baseUrl);
    return c.json({ status: 'success', data: result });
  } catch (err) {
    return handleError(c, err);
  }
};

app.get('/api/lk21/movie/:slug', handleLk21Detail);
app.get('/api/lk21/series/:slug', handleLk21Detail);
app.get('/api/lk21/detail/:slug', handleLk21Detail);
app.get('/api/lk21/detail', handleLk21Detail);

// Handler Stream & Watch LK21
const handleLk21Stream = async (c: any) => {
  const slug = c.req.param('slug');
  const targetUrl = c.req.query('url');
  const input = slug || (targetUrl ? decodeURIComponent(targetUrl) : '');
  const server = c.req.query('server');
  const baseUrl = c.req.query('base');

  if (!input) {
    return c.json(
      {
        status: 'error',
        message: 'Parameter "slug" or query "url" is required.',
        code: 'MISSING_TARGET_PARAM',
      },
      400
    );
  }

  try {
    const result = await scrapeLk21Stream(
      input,
      server ? decodeURIComponent(server) : undefined,
      baseUrl
    );
    return c.json({ status: 'success', data: result });
  } catch (err) {
    return handleError(c, err);
  }
};

app.get('/api/lk21/watch/:slug', handleLk21Stream);
app.get('/api/lk21/stream', handleLk21Stream);
app.get('/api/lk21/watch', handleLk21Stream);

/* ========================================================================= */
/*                             IDLIX ENDPOINTS                               */
/* ========================================================================= */

// Handler Home / Latest IDLIX
const handleIdlixLatest = async (c: any) => {
  const page = Number(c.req.query('page')) || 1;
  const typeParam = c.req.query('type') === 'series' ? 'series' : 'movie';
  const baseUrl = c.req.query('base');

  try {
    const result = await scrapeIdlixLatest(page, typeParam, baseUrl);
    return c.json({
      status: 'success',
      data: result.items,
      page: result.page,
      hasMore: result.hasMore,
    });
  } catch (err) {
    return handleError(c, err);
  }
};

app.get('/api/idlix/home', handleIdlixLatest);
app.get('/api/idlix/latest', handleIdlixLatest);

// Handler Search IDLIX
app.get('/api/idlix/search', async (c) => {
  const query = c.req.query('q');
  const page = Number(c.req.query('page')) || 1;
  const baseUrl = c.req.query('base');

  if (!query) {
    return c.json(
      {
        status: 'error',
        message: 'Query parameter "q" is required.',
        code: 'MISSING_QUERY',
      },
      400
    );
  }

  try {
    const result = await scrapeIdlixSearch(query, page, baseUrl);
    return c.json({
      status: 'success',
      data: result.items,
      page: result.page,
      hasMore: result.hasMore,
    });
  } catch (err) {
    return handleError(c, err);
  }
});

// Handler Detail IDLIX (Bisa via :slug maupun query ?url=)
const handleIdlixDetail = async (c: any, defaultType: 'movie' | 'series' = 'movie') => {
  const slug = c.req.param('slug');
  const targetUrl = c.req.query('url');
  const input = slug || (targetUrl ? decodeURIComponent(targetUrl) : '');
  const baseUrl = c.req.query('base');

  if (!input) {
    return c.json(
      {
        status: 'error',
        message: 'Parameter "slug" or query "url" is required.',
        code: 'MISSING_TARGET_PARAM',
      },
      400
    );
  }

  try {
    const result = await scrapeIdlixDetail(input, defaultType, baseUrl);
    return c.json({ status: 'success', data: result });
  } catch (err) {
    return handleError(c, err);
  }
};

app.get('/api/idlix/movie/:slug', (c) => handleIdlixDetail(c, 'movie'));
app.get('/api/idlix/series/:slug', (c) => handleIdlixDetail(c, 'series'));
app.get('/api/idlix/detail/:slug', (c) => handleIdlixDetail(c, 'movie'));
app.get('/api/idlix/detail', (c) => handleIdlixDetail(c, 'movie'));

// Handler Stream & Watch IDLIX
const handleIdlixStream = async (c: any) => {
  const slug = c.req.param('slug');
  const targetUrl = c.req.query('url');
  const input = slug || (targetUrl ? decodeURIComponent(targetUrl) : '');
  const server = c.req.query('server');
  const typeParam = c.req.query('type') === 'series' ? 'series' : 'movie';
  const baseUrl = c.req.query('base');

  if (!input) {
    return c.json(
      {
        status: 'error',
        message: 'Parameter "slug" or query "url" is required.',
        code: 'MISSING_TARGET_PARAM',
      },
      400
    );
  }

  try {
    const result = await scrapeIdlixStream(
      input,
      server ? decodeURIComponent(server) : undefined,
      typeParam,
      baseUrl
    );
    return c.json({ status: 'success', data: result });
  } catch (err) {
    return handleError(c, err);
  }
};

app.get('/api/idlix/watch/:slug', handleIdlixStream);
app.get('/api/idlix/stream', handleIdlixStream);
app.get('/api/idlix/watch', handleIdlixStream);

/* ========================================================================= */
/*                          STREAM M3U8 CORS PROXY                           */
/* ========================================================================= */

// Endpoint proxy untuk mengatasi CORS issue pada HLS player web (misal hls.js / browser)
app.get('/api/proxy/m3u8', async (c) => {
  const targetUrl = c.req.query('url');
  const referer = c.req.query('referer') || 'https://playcdn.de/';

  if (!targetUrl) {
    return c.text('Missing "url" query parameter', 400);
  }

  try {
    const decodedUrl = decodeURIComponent(targetUrl);
    const origin = referer.replace(/\/$/, '');

    const response = await fetch(decodedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: referer,
        Origin: origin,
      },
    });

    if (!response.ok) {
      return c.text(`Upstream stream error: ${response.status}`, response.status as any);
    }

    const playlistText = await response.text();

    return c.body(playlistText, 200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
  } catch (err: any) {
    return c.text(`Proxy failed: ${err.message}`, 500);
  }
});

/* ========================================================================= */
/*                          404 & SERVER LIFECYCLE                           */
/* ========================================================================= */

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
