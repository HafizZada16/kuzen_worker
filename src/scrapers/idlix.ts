import type { Page } from 'playwright';
import { withPage } from '../browser.js';
import {
  type MovieDetail,
  type MovieEpisodeItem,
  type MovieListItem,
  type MoviePlayerItem,
  type MovieStreamResult,
  type PaginationResult,
  type ServerListItem,
  type StreamItem,
  ScraperError,
} from '../types.js';
import {
  cleanMovieTitle,
  DEFAULT_TIMEOUT_MS,
  extractSlug,
  waitIfCloudflare,
} from './utils.js';

export const DEFAULT_IDLIX_BASE_URL = 'https://z2.idlixku.com';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

function resolveIdlixPoster(path?: string | null): string {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${TMDB_IMAGE_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Scraper daftar film & serial terbaru dari IDLIX (Mendukung Web HTML & Next.js API)
 */
export async function scrapeIdlixLatest(
  pageNumber: number = 1,
  type: 'movie' | 'series' = 'movie',
  baseUrl: string = DEFAULT_IDLIX_BASE_URL
): Promise<PaginationResult<MovieListItem>> {
  const path = type === 'series' ? 'series' : 'movie';
  const targetUrl =
    pageNumber === 1
      ? `${baseUrl.replace(/\/$/, '')}/${path}`
      : `${baseUrl.replace(/\/$/, '')}/${path}?page=${pageNumber}`;

  return withPage(
    async (page: Page) => {
      console.log(`[IDLIX] Scraping latest ${type} from: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      // Tunggu hingga link kartu film muncul di DOM
      await page.waitForSelector(`a[href*="/${path}/"]`, { timeout: 10_000 }).catch(() => null);

      const result = await page.evaluate(
        ({ base, currentPage, defaultType, sectionPath }) => {
          const items: any[] = [];
          const seenSlugs = new Set<string>();

          // Ambil semua anchor card yang menuju ke detail film/series
          const cardLinks = Array.from(
            document.querySelectorAll(`a[href*="/${sectionPath}/"]`)
          );

          for (const linkEl of cardLinks) {
            const href = linkEl.getAttribute('href') || '';
            if (!href || href === `/${sectionPath}` || href.includes('?')) continue;

            const fullUrl = href.startsWith('http') ? href : new URL(href, base).toString();
            const u = new URL(fullUrl);
            const slug = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
            if (!slug || seenSlugs.has(slug)) continue;
            seenSlugs.add(slug);

            const title =
              linkEl.textContent?.trim() ||
              linkEl.getAttribute('title')?.trim() ||
              slug.replace(/-/g, ' ');

            const imgEl = linkEl.querySelector('img') || linkEl.closest('.group')?.querySelector('img');
            const poster =
              imgEl?.getAttribute('src') ||
              imgEl?.getAttribute('data-src') ||
              '';

            items.push({
              title: title.replace(/^nonton\s+/i, '').replace(/\s+sub\s+indo$/i, '').trim(),
              slug,
              url: fullUrl,
              thumb: poster.startsWith('http') ? poster : poster ? new URL(poster, base).toString() : '',
              poster: poster.startsWith('http') ? poster : poster ? new URL(poster, base).toString() : '',
              type: defaultType,
            });
          }

          return {
            page: currentPage,
            hasMore: items.length >= 10,
            items,
          };
        },
        { base: baseUrl, currentPage: pageNumber, defaultType: type, sectionPath: path }
      );

      return result;
    },
    { blockImages: false }
  );
}

/**
 * Scraper pencarian judul di IDLIX
 */
export async function scrapeIdlixSearch(
  query: string,
  pageNumber: number = 1,
  baseUrl: string = DEFAULT_IDLIX_BASE_URL
): Promise<PaginationResult<MovieListItem>> {
  if (!query || query.trim().length === 0) {
    throw new ScraperError('Search query parameter is required.', 400, 'MISSING_QUERY');
  }

  const encodedQuery = encodeURIComponent(query.trim());
  const targetUrl = `${baseUrl.replace(/\/$/, '')}/search?q=${encodedQuery}`;

  return withPage(
    async (page: Page) => {
      console.log(`[IDLIX] Searching "${query}" from: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      await page.waitForTimeout(2000);

      const result = await page.evaluate(
        ({ base, currentPage }) => {
          const items: any[] = [];
          const seenSlugs = new Set<string>();

          const cardLinks = Array.from(
            document.querySelectorAll('a[href*="/movie/"], a[href*="/series/"]')
          );

          for (const linkEl of cardLinks) {
            const href = linkEl.getAttribute('href') || '';
            if (!href || href === '/movie' || href === '/series') continue;

            const fullUrl = href.startsWith('http') ? href : new URL(href, base).toString();
            const u = new URL(fullUrl);
            const slug = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
            if (!slug || seenSlugs.has(slug)) continue;
            seenSlugs.add(slug);

            const title =
              linkEl.textContent?.trim() ||
              linkEl.getAttribute('title')?.trim() ||
              slug.replace(/-/g, ' ');

            const imgEl = linkEl.querySelector('img') || linkEl.closest('.group')?.querySelector('img');
            const poster = imgEl?.getAttribute('src') || '';
            const isSeries = fullUrl.includes('/series/');

            items.push({
              title: title.replace(/^nonton\s+/i, '').replace(/\s+sub\s+indo$/i, '').trim(),
              slug,
              url: fullUrl,
              thumb: poster.startsWith('http') ? poster : poster ? new URL(poster, base).toString() : '',
              poster: poster.startsWith('http') ? poster : poster ? new URL(poster, base).toString() : '',
              type: isSeries ? 'series' : 'movie',
            });
          }

          return {
            page: currentPage,
            hasMore: items.length >= 10,
            items,
          };
        },
        { base: baseUrl, currentPage: pageNumber }
      );

      return result;
    },
    { blockImages: false }
  );
}

/**
 * Scraper detail film / serial IDLIX via Next.js REST API
 */
export async function scrapeIdlixDetail(
  urlOrSlug: string,
  type: 'movie' | 'series' = 'movie',
  baseUrl: string = DEFAULT_IDLIX_BASE_URL
): Promise<MovieDetail> {
  const cleanSlug = extractSlug(urlOrSlug, baseUrl);
  if (!cleanSlug) {
    throw new ScraperError('Invalid slug or URL provided.', 400, 'INVALID_SLUG');
  }

  const isSeries = urlOrSlug.includes('/series/') || type === 'series';
  const section = isSeries ? 'series' : 'movies';
  const pageUrl = `${baseUrl.replace(/\/$/, '')}/${isSeries ? 'series' : 'movie'}/${cleanSlug}`;

  return withPage(
    async (page: Page) => {
      console.log(`[IDLIX] Fetching detail for ${cleanSlug} via internal API...`);
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      const raw = await page.evaluate(
        async ({ apiSection, slug }) => {
          try {
            const resp = await fetch(`/api/${apiSection}/${slug}`);
            if (!resp.ok) return null;
            return await resp.json();
          } catch {
            return null;
          }
        },
        { apiSection: section, slug: cleanSlug }
      );

      if (!raw || !raw.title) {
        throw new ScraperError('Failed to fetch movie detail from IDLIX API.', 404, 'NOT_FOUND');
      }

      const title = cleanMovieTitle(raw.title);
      const poster = resolveIdlixPoster(raw.posterPath);
      const backdrop = resolveIdlixPoster(raw.backdropPath);
      const synopsis = raw.overview || 'Tidak ada sinopsis tersedia.';
      const rating = raw.voteAverage ? parseFloat(raw.voteAverage).toFixed(1) : undefined;
      const releaseYear = (raw.releaseDate || raw.firstAirDate || '')?.slice(0, 4) || undefined;
      const duration = raw.runtime ? `${raw.runtime} min` : undefined;
      const genres = Array.isArray(raw.genres) ? raw.genres.map((g: any) => g.name || g) : [];

      const info: Record<string, string> = {};
      if (raw.director) info['Director'] = raw.director;
      if (raw.country) info['Country'] = raw.country;
      if (rating) info['Rating'] = rating;
      if (releaseYear) info['Year'] = releaseYear;
      if (duration) info['Duration'] = duration;
      if (genres.length > 0) info['Genre'] = genres.join(', ');
      if (Array.isArray(raw.cast) && raw.cast.length > 0) {
        info['Cast'] = raw.cast.slice(0, 5).map((c: any) => c.name || c).join(', ');
      }

      // Format Season & Episode untuk series
      const episodes: MovieEpisodeItem[] = [];
      if (Array.isArray(raw.seasons)) {
        for (const s of raw.seasons) {
          const sNum = s.seasonNumber?.toString() || '1';
          const epCount = s.episodeCount || 1;
          for (let ep = 1; ep <= epCount; ep++) {
            episodes.push({
              episode: ep.toString(),
              title: `Season ${sNum} Episode ${ep}`,
              slug: `${cleanSlug}/season/${sNum}/episode/${ep}`,
              seasonNumber: sNum,
              url: `${baseUrl.replace(/\/$/, '')}/series/${cleanSlug}/season/${sNum}/episode/${ep}`,
            });
          }
        }
      }

      return {
        title,
        slug: cleanSlug,
        thumb: poster,
        poster,
        backdrop,
        synopsis,
        rating,
        year: releaseYear,
        release: releaseYear,
        duration,
        genres,
        info,
        players: [],
        streams: [],
        serverList: [],
        episodes: episodes.length > 0 ? episodes : null,
        trailerUrl: raw.trailerUrl || undefined,
        originalUrl: pageUrl,
        type: isSeries ? 'series' : 'movie',
      };
    },
    { blockImages: true }
  );
}

/**
 * Scraper ekstraksi video stream HLS murni (`.m3u8`) & subtitle dari IDLIX Gate Session
 */
export async function scrapeIdlixStream(
  urlOrSlug: string,
  requestedServer?: string,
  type: 'movie' | 'series' = 'movie',
  baseUrl: string = DEFAULT_IDLIX_BASE_URL
): Promise<MovieStreamResult> {
  const isSeries = urlOrSlug.includes('/series/') || urlOrSlug.includes('/episode/') || type === 'series';
  const cleanSlug = extractSlug(urlOrSlug, baseUrl);

  // Normalisasi URL target halaman
  let targetUrl = urlOrSlug.startsWith('http')
    ? urlOrSlug
    : `${baseUrl.replace(/\/$/, '')}/${isSeries ? 'series' : 'movie'}/${cleanSlug}`;

  return withPage(
    async (page: Page) => {
      console.log(`[IDLIX] Extracting stream for ${targetUrl}...`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      // Jalankan alur Claim Session IDLIX langsung di dalam konteks sesi browser
      const sessionResult = await page.evaluate(async () => {
        try {
          // 1. Dapatkan metadata target
          const path = window.location.pathname;
          let playInfoEndpoint = '';

          if (path.includes('/episode/')) {
            // Ambil ID episode dari API series
            const match = path.match(/\/series\/([^/]+)\/season\/(\d+)\/episode\/(\d+)/);
            if (match) {
              const [, sSlug, sNum, epNum] = match;
              const epData = await (await fetch(`/api/series/${sSlug}/season/${sNum}/episode/${epNum}`)).json();
              if (epData.episode?.id) {
                playInfoEndpoint = `/api/watch/play-info/episode/${epData.episode.id}`;
              }
            }
          } else {
            const mSlug = path.replace('/movie/', '').replace(/\/$/, '');
            const mData = await (await fetch(`/api/movies/${mSlug}`)).json();
            if (mData.id) {
              playInfoEndpoint = `/api/watch/play-info/movie/${mData.id}`;
            }
          }

          if (!playInfoEndpoint) {
            return { error: 'Failed to resolve play-info endpoint' };
          }

          // 2. Minta Gate Token
          const playInfoRes = await fetch(playInfoEndpoint);
          if (!playInfoRes.ok) return { error: `Play-info error: ${playInfoRes.status}` };
          const playInfo = await playInfoRes.json();

          if (!playInfo.gateToken) {
            return { error: 'No gate token returned' };
          }

          // 3. Tunggu countdown unlock (biasanya 15 detik)
          const waitMs = Math.max(0, (playInfo.unlockAt - playInfo.serverNow) + 500);
          await new Promise((r) => setTimeout(r, waitMs));

          // 4. Claim Session
          const claimRes = await fetch('/api/watch/session/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gateToken: playInfo.gateToken }),
          });
          if (!claimRes.ok) return { error: `Claim error: ${claimRes.status}` };
          const claimData = await claimRes.json();

          // 5. Redeem ke MajorPlay CDN
          if (claimData.redeemUrl && claimData.claim) {
            const redeemRes = await fetch(claimData.redeemUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ claim: claimData.claim }),
            });
            if (redeemRes.ok) {
              const redeemData = await redeemRes.json();
              return {
                title: claimData.title,
                durationSec: claimData.durationSec,
                streamUrl: redeemData.url,
                subtitles: redeemData.subtitles || [],
              };
            }
          }

          return { claimData };
        } catch (err: any) {
          return { error: err.message };
        }
      });

      if (sessionResult.error) {
        throw new ScraperError(
          `IDLIX stream extraction failed: ${sessionResult.error}`,
          422,
          'STREAM_EXTRACT_FAILED'
        );
      }

      const streamUrl = sessionResult.streamUrl || '';
      const streamItems: StreamItem[] = [];
      const players: MoviePlayerItem[] = [];

      if (streamUrl) {
        streamItems.push({
          server: 'MajorPlay HLS (720p)',
          url: streamUrl,
          type: 'hls',
        });
        players.push({
          provider: 'MajorPlay HLS',
          url: streamUrl,
        });
      }

      const serverList: ServerListItem[] = [
        {
          serverName: 'MajorPlay HLS',
          label: 'MajorPlay (720p)',
          url: streamUrl,
        },
      ];

      const videoSources = streamItems.map((s) => ({
        label: s.server,
        file: s.url,
        type: s.type,
      }));

      const subtitles = (sessionResult.subtitles || []).map((sub: any) => ({
        lang: sub.lang || 'id',
        label: sub.label || 'Indonesian',
        url: sub.path || sub.url || '',
      }));

      return {
        title: sessionResult.title || cleanSlug,
        slug: cleanSlug,
        stream_url: streamUrl,
        iframe: streamUrl,
        servers: serverList,
        serverList,
        players,
        streams: streamItems,
        subtitles,
        video_sources: videoSources,
        originalUrl: targetUrl,
      };
    },
    { blockImages: true }
  );
}
