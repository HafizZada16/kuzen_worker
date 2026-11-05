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
  cleanText,
  DEFAULT_TIMEOUT_MS,
  detectStreamType,
  extractSlug,
  isValidPlayerIframe,
  waitIfCloudflare,
} from './utils.js';

export const DEFAULT_LK21_BASE_URL = 'https://tv12.lk21official.cc';

/**
 * Normalisasi URL relatif ke URL absolut LK21
 */
function toAbsoluteUrl(href: string, base: string): string {
  if (!href) return '';
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/**
 * Helper untuk memastikan parameter berupa URL lengkap
 */
function resolveLk21TargetUrl(input: string, baseUrl: string = DEFAULT_LK21_BASE_URL): string {
  if (!input) return '';
  if (input.startsWith('http://') || input.startsWith('https://')) {
    return input;
  }
  const cleanSlug = input.replace(/^\/+|\/+$/g, '');
  return `${baseUrl.replace(/\/$/, '')}/${cleanSlug}/`;
}

/**
 * Scraper daftar film terbaru / terpopuler dari LK21
 */
export async function scrapeLk21Latest(
  pageNumber: number = 1,
  baseUrl: string = DEFAULT_LK21_BASE_URL
): Promise<PaginationResult<MovieListItem>> {
  const targetUrl =
    pageNumber === 1
      ? `${baseUrl.replace(/\/$/, '')}/latest/`
      : `${baseUrl.replace(/\/$/, '')}/latest/page/${pageNumber}/`;

  return withPage(
    async (page: Page) => {
      console.log(`[LK21] Scraping latest movies from: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      await page.waitForSelector('article, .item, .gallery-grid, #content', {
        timeout: 10_000,
      }).catch(() => null);

      const result = await page.evaluate(
        ({ base, currentPage }) => {
          const items: any[] = [];
          const seenSlugs = new Set<string>();

          const elements = Array.from(
            document.querySelectorAll(
              'article, .gallery-grid .item, .content .item, .mega-item, .grid-item'
            )
          );

          for (const el of elements) {
            const linkEl =
              el.querySelector<HTMLAnchorElement>('a[href*="/"]') ||
              el.closest('a') ||
              el.querySelector<HTMLAnchorElement>('.entry-title a, h2 a, h3 a');
            if (!linkEl) continue;

            const href = linkEl.getAttribute('href') || '';
            if (
              !href ||
              href.includes('/page/') ||
              href.includes('/genre/') ||
              href.includes('/country/') ||
              href.includes('/year/') ||
              href.includes('/cast/') ||
              href.includes('/tag/')
            ) {
              continue;
            }

            const fullUrl = href.startsWith('http') ? href : new URL(href, base).toString();
            const u = new URL(fullUrl);
            const slug = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
            if (!slug || seenSlugs.has(slug)) continue;
            seenSlugs.add(slug);

            const titleEl = el.querySelector('.entry-title, h2, h3, .title, a[title]');
            const rawTitle =
              titleEl?.textContent?.trim() ||
              linkEl.getAttribute('title')?.trim() ||
              el.querySelector('img')?.getAttribute('alt')?.trim() ||
              '';

            if (!rawTitle) continue;

            const title = rawTitle
              .replace(/^nonton\s+/i, '')
              .replace(/\s+sub\s+indo$/i, '')
              .replace(/\s+subtitle\s+indonesia$/i, '')
              .trim();

            const imgEl = el.querySelector<HTMLImageElement>('img');
            const poster =
              imgEl?.getAttribute('data-src') ||
              imgEl?.getAttribute('data-original') ||
              imgEl?.getAttribute('src') ||
              '';

            const ratingEl = el.querySelector('.rating, .rating-archive, span.rating, .star');
            const rating = ratingEl?.textContent?.replace(/[^\d.]/g, '').trim() || undefined;

            const qualityEl = el.querySelector('.quality, span.quality, .label-quality');
            const quality = qualityEl?.textContent?.trim() || undefined;

            const yearMatch = el.textContent?.match(/\b(19\d\d|20\d\d)\b/);
            const year = yearMatch ? yearMatch[1] : undefined;

            const type = fullUrl.includes('/series/') || fullUrl.includes('/tv/') ? 'series' : 'movie';
            const resolvedPoster = poster.startsWith('http')
              ? poster
              : poster
              ? new URL(poster, base).toString()
              : '';

            items.push({
              title,
              slug,
              url: fullUrl,
              thumb: resolvedPoster,
              poster: resolvedPoster,
              rating,
              quality,
              year,
              type,
            });
          }

          const nextBtn = document.querySelector(
            '.pagination a.next, .page-numbers.next, a[rel="next"], a.next'
          );
          const hasMore = nextBtn !== null || items.length >= 10;

          return {
            page: currentPage,
            hasMore,
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
 * Scraper pencarian film LK21
 */
export async function scrapeLk21Search(
  query: string,
  pageNumber: number = 1,
  baseUrl: string = DEFAULT_LK21_BASE_URL
): Promise<PaginationResult<MovieListItem>> {
  if (!query || query.trim().length === 0) {
    throw new ScraperError('Search query parameter is required.', 400, 'MISSING_QUERY');
  }

  const encodedQuery = encodeURIComponent(query.trim());
  const targetUrl =
    pageNumber === 1
      ? `${baseUrl.replace(/\/$/, '')}/?s=${encodedQuery}`
      : `${baseUrl.replace(/\/$/, '')}/page/${pageNumber}/?s=${encodedQuery}`;

  return withPage(
    async (page: Page) => {
      console.log(`[LK21] Searching "${query}" from: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      await page.waitForSelector('article, .item, .search-item, #content', {
        timeout: 10_000,
      }).catch(() => null);

      const result = await page.evaluate(
        ({ base, currentPage }) => {
          const items: any[] = [];
          const seenSlugs = new Set<string>();

          const elements = Array.from(
            document.querySelectorAll(
              'article, .gallery-grid .item, .content .item, .search-item, .mega-item, .grid-item'
            )
          );

          for (const el of elements) {
            const linkEl =
              el.querySelector<HTMLAnchorElement>('.entry-title a, h2 a, h3 a, a[href*="/"]') ||
              el.closest('a');
            if (!linkEl) continue;

            const href = linkEl.getAttribute('href') || '';
            if (
              !href ||
              href.includes('/page/') ||
              href.includes('/genre/') ||
              href.includes('/country/') ||
              href.includes('/year/')
            ) {
              continue;
            }

            const fullUrl = href.startsWith('http') ? href : new URL(href, base).toString();
            const u = new URL(fullUrl);
            const slug = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
            if (!slug || seenSlugs.has(slug)) continue;
            seenSlugs.add(slug);

            const rawTitle =
              linkEl.textContent?.trim() ||
              el.querySelector('.entry-title, h2, h3')?.textContent?.trim() ||
              '';
            if (!rawTitle) continue;

            const title = rawTitle
              .replace(/^nonton\s+/i, '')
              .replace(/\s+sub\s+indo$/i, '')
              .replace(/\s+subtitle\s+indonesia$/i, '')
              .trim();

            const imgEl = el.querySelector<HTMLImageElement>('img');
            const poster =
              imgEl?.getAttribute('data-src') ||
              imgEl?.getAttribute('data-original') ||
              imgEl?.getAttribute('src') ||
              '';

            const ratingEl = el.querySelector('.rating, .rating-archive, span.rating');
            const rating = ratingEl?.textContent?.replace(/[^\d.]/g, '').trim() || undefined;

            const qualityEl = el.querySelector('.quality, span.quality');
            const quality = qualityEl?.textContent?.trim() || undefined;

            const yearMatch = el.textContent?.match(/\b(19\d\d|20\d\d)\b/);
            const year = yearMatch ? yearMatch[1] : undefined;

            const type = fullUrl.includes('/series/') || fullUrl.includes('/tv/') ? 'series' : 'movie';
            const resolvedPoster = poster.startsWith('http')
              ? poster
              : poster
              ? new URL(poster, base).toString()
              : '';

            items.push({
              title,
              slug,
              url: fullUrl,
              thumb: resolvedPoster,
              poster: resolvedPoster,
              rating,
              quality,
              year,
              type,
            });
          }

          const nextBtn = document.querySelector('.pagination a.next, .page-numbers.next, a.next');
          return {
            page: currentPage,
            hasMore: nextBtn !== null,
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
 * Scraper detail sinopsis & metadata film/series LK21 (Format api_kuzen & kuzen_app compliant)
 */
export async function scrapeLk21Detail(
  urlOrSlug: string,
  baseUrl: string = DEFAULT_LK21_BASE_URL
): Promise<MovieDetail> {
  const targetUrl = resolveLk21TargetUrl(urlOrSlug, baseUrl);

  return withPage(
    async (page: Page) => {
      console.log(`[LK21] Scraping movie detail from: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      await page.waitForSelector('h1, .entry-title, #content', {
        timeout: 10_000,
      }).catch(() => null);

      const parsed = await page.evaluate(({ base, target }) => {
        const titleEl = document.querySelector('h1.entry-title, h1');
        let rawTitle = titleEl?.textContent?.trim() || '';

        // Baca watch-history-data script jika tersedia di LK21
        const historyDataScript = document.querySelector('#watch-history-data')?.textContent;
        let historyJson: any = null;
        if (historyDataScript) {
          try {
            historyJson = JSON.parse(historyDataScript);
            if (historyJson.title && (rawTitle.includes('Layarkaca') || !rawTitle)) {
              rawTitle = historyJson.title;
            }
          } catch {}
        }

        const title = rawTitle
          .replace(/^nonton\s+/i, '')
          .replace(/\s+sub\s+indo$/i, '')
          .replace(/\s+subtitle\s+indonesia$/i, '')
          .trim();

        // Sinopsis
        const synopsisEl = document.querySelector(
          '.entry-content p, blockquote, .sinopsis, #synopsis, .desc-text, .entry-content'
        );
        const synopsis = synopsisEl?.textContent?.trim() || '';

        // Poster / Thumb
        const posterEl = document.querySelector<HTMLImageElement>(
          '.poster img, .content-poster img, .entry-content img, .cover img, meta[property="og:image"]'
        );
        let poster =
          posterEl?.getAttribute('data-src') ||
          posterEl?.getAttribute('src') ||
          posterEl?.getAttribute('content') ||
          '';

        if (historyJson?.poster && !poster) {
          poster = historyJson.poster;
        }

        // Info Key-Value Object (sesuai format api_kuzen `info: {}`)
        const info: Record<string, string> = {};
        const infoRows = Array.from(
          document.querySelectorAll('.content-info > div, .film-content p, .info-content li')
        );
        for (const row of infoRows) {
          const txt = row.textContent?.trim() || '';
          if (txt.includes(':')) {
            const [k, ...v] = txt.split(':');
            const key = k.trim();
            const val = v.join(':').trim();
            if (key && val) info[key] = val;
          }
        }

        // Rating
        const ratingEl = document.querySelector(
          '.rating, .rating-archive, span[itemprop="ratingValue"], .star-score'
        );
        const rating =
          historyJson?.rating ||
          info['Rating'] ||
          ratingEl?.textContent?.replace(/[^\d.]/g, '').trim() ||
          undefined;

        // Tahun & Durasi
        const textContent = document.body.textContent || '';
        const yearMatch =
          info['Tahun'] ||
          info['Year'] ||
          textContent.match(/Tahun:\s*(\d{4})/i)?.[1] ||
          textContent.match(/\b(19\d\d|20\d\d)\b/)?.[1];
        const year = yearMatch || undefined;

        const durationMatch =
          info['Durasi'] ||
          info['Duration'] ||
          textContent.match(/(\d+\s*(?:min|menit|hours?|jam))/i)?.[1];
        const duration = durationMatch || undefined;

        // Genres
        const genreElements = Array.from(
          document.querySelectorAll('a[href*="/genre/"], a[rel="category tag"]')
        );
        const genres = Array.from(
          new Set(
            genreElements
              .map((g) => g.textContent?.trim() || '')
              .filter((g) => g.length > 0 && !g.toLowerCase().includes('movie'))
          )
        );

        // Trailer
        const trailerIframe = document.querySelector<HTMLIFrameElement>(
          'iframe[src*="youtube.com"], iframe[src*="youtu.be"]'
        );
        const trailerUrl = trailerIframe?.getAttribute('src') || undefined;

        // Players
        const players: Array<{ provider: string; url: string }> = [];
        const seenPlayerUrls = new Set<string>();

        const iframes = Array.from(
          document.querySelectorAll('#muvipro-player iframe, .player-content iframe, #player iframe, iframe')
        );
        for (const frame of iframes) {
          const src = frame.getAttribute('src') || '';
          if (
            src &&
            !src.includes('about:blank') &&
            !src.includes('google') &&
            !src.includes('facebook') &&
            !seenPlayerUrls.has(src)
          ) {
            seenPlayerUrls.add(src);
            players.push({
              provider: 'Default',
              url: src.startsWith('//') ? `https:${src}` : src,
            });
          }
        }

        // Server list buttons
        const serverElements = Array.from(
          document.querySelectorAll('#server-list a, .tab-server a, .server-item, .nav-tabs li a')
        );
        const serverList: Array<{ serverName: string; label: string; url: string }> = [];
        for (const sEl of serverElements) {
          const sName = sEl.textContent?.trim() || '';
          const sHref = sEl.getAttribute('href') || sEl.getAttribute('data-href') || '';
          if (sName) {
            serverList.push({
              serverName: sName,
              label: sName,
              url: sHref.startsWith('http') ? sHref : sHref ? new URL(sHref, target).toString() : '',
            });
          }
        }

        // Episodes jika Series
        const episodes: any[] = [];
        const seasonDataScript = document.querySelector('#season-data')?.textContent;
        if (seasonDataScript) {
          try {
            const seasons = JSON.parse(seasonDataScript);
            Object.keys(seasons).forEach((sNum) => {
              seasons[sNum].forEach((ep: any) => {
                const epSlug = ep.slug || '';
                episodes.push({
                  episode: ep.episode_no?.toString() || ep.episode?.toString() || '1',
                  title: ep.title || `Episode ${ep.episode_no || '1'}`,
                  slug: epSlug,
                  url: epSlug.startsWith('http') ? epSlug : `${base}/${epSlug}/`,
                  seasonNumber: sNum,
                });
              });
            });
          } catch {}
        }

        if (episodes.length === 0) {
          const epElements = Array.from(
            document.querySelectorAll(
              '.episodelist a, #episode-list a, .episode-box a, .episodios li a, a[href*="-season-"]'
            )
          );
          for (let i = 0; i < epElements.length; i++) {
            const el = epElements[i];
            const epHref = el.getAttribute('href') || '';
            const epTitle = el.textContent?.trim() || '';
            if (epHref && epTitle) {
              const fullEpHref = epHref.startsWith('http') ? epHref : new URL(epHref, base).toString();
              const u = new URL(fullEpHref);
              const epSlug = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
              const epNumMatch = epTitle.match(/episode\s*(\d+)/i) || epTitle.match(/ep\s*(\d+)/i);
              episodes.push({
                episode: epNumMatch ? epNumMatch[1] : (i + 1).toString(),
                title: epTitle,
                slug: epSlug,
                url: fullEpHref,
              });
            }
          }
        }

        const isSeries =
          episodes.length > 0 ||
          target.includes('/series/') ||
          target.includes('/tv/');

        return {
          title,
          synopsis,
          poster,
          rating,
          year,
          duration,
          genres,
          info,
          players,
          serverList,
          trailerUrl,
          type: (isSeries ? 'series' : 'movie') as 'movie' | 'series',
          episodes: episodes.length > 0 ? episodes : null,
        };
      }, { base: baseUrl, target: targetUrl });

      const finalSlug = extractSlug(targetUrl, baseUrl);
      const resolvedPoster = toAbsoluteUrl(parsed.poster, targetUrl);

      return {
        title: parsed.title,
        slug: finalSlug,
        thumb: resolvedPoster,
        poster: resolvedPoster,
        synopsis: parsed.synopsis,
        rating: parsed.rating,
        year: parsed.year,
        release: parsed.year,
        duration: parsed.duration,
        genres: parsed.genres,
        info: parsed.info,
        players: parsed.players,
        streams: parsed.players.map((p) => ({
          server: p.provider,
          url: p.url,
          type: detectStreamType(p.url),
        })),
        serverList: parsed.serverList,
        iframe: parsed.players[0]?.url || '',
        stream_url: parsed.players[0]?.url || '',
        episodes: parsed.episodes,
        trailerUrl: parsed.trailerUrl,
        originalUrl: targetUrl,
        type: parsed.type,
      };
    },
    { blockImages: false }
  );
}

/**
 * Scraper ekstraksi video stream & player iframe LK21
 */
export async function scrapeLk21Stream(
  urlOrSlug: string,
  requestedServer?: string,
  baseUrl: string = DEFAULT_LK21_BASE_URL
): Promise<MovieStreamResult> {
  const targetUrl = resolveLk21TargetUrl(urlOrSlug, baseUrl);

  return withPage(
    async (page: Page) => {
      console.log(`[LK21] Extracting stream from: ${targetUrl}`);

      const capturedStreams: StreamItem[] = [];
      const seenStreams = new Set<string>();
      let directStreamUrl = '';

      page.on('response', async (response) => {
        try {
          const resUrl = response.url();
          const contentType = response.headers()['content-type'] || '';

          // Intercept verify response dari playcdn.de untuk mendapatkan fileUrl m3u8 asli
          if (resUrl.includes('playcdn.de/verify/')) {
            try {
              const verifyJson = await response.json();
              if (verifyJson?.fileUrl) {
                directStreamUrl = verifyJson.fileUrl;
                console.log('[LK21] Extracted Direct PlayCDN HLS Stream:', directStreamUrl);
                if (!seenStreams.has(directStreamUrl)) {
                  seenStreams.add(directStreamUrl);
                  capturedStreams.unshift({
                    server: 'PlayCDN HLS (Direct)',
                    url: directStreamUrl,
                    type: 'hls',
                  });
                }
              }
            } catch {}
          }

          if (
            resUrl.includes('.m3u8') ||
            contentType.includes('application/vnd.apple.mpegurl') ||
            contentType.includes('application/x-mpegurl')
          ) {
            if (!seenStreams.has(resUrl)) {
              seenStreams.add(resUrl);
              capturedStreams.push({
                server: 'HLS Stream',
                url: resUrl,
                type: 'hls',
              });
              console.log('[LK21] Captured HLS Stream:', resUrl);
            }
          }
        } catch {}
      });

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      // Beri jeda sejenak untuk trigger verify request dari player
      await page.waitForTimeout(3000);

      const rawTitle = cleanText(
        (await page.$eval('h1.entry-title, h1', (el) => el.textContent).catch(() => null)) ||
          (await page.title())
      );
      const title = cleanMovieTitle(rawTitle);
      const slug = extractSlug(targetUrl, baseUrl);

      const thumb = await page
        .evaluate(() => {
          const img = document.querySelector<HTMLImageElement>(
            '.poster img, .content-poster img, meta[property="og:image"]'
          );
          return img?.getAttribute('data-src') || img?.getAttribute('src') || img?.getAttribute('content') || '';
        })
        .catch(() => '');

      // Trigger "Load Player" jika ada
      const loadPlayerBtn = await page.$(
        '#load-player, .load-player, #btn-player, button:has-text("Play"), a:has-text("Play")'
      );
      if (loadPlayerBtn) {
        await loadPlayerBtn.click().catch(() => null);
        await page.waitForTimeout(1500);
      }

      // Daftar server
      const serverList: ServerListItem[] = await page.evaluate(() => {
        const servers: ServerListItem[] = [];
        const seen = new Set<string>();

        const elements = Array.from(
          document.querySelectorAll(
            '#server-list a, .tab-server a, .server-item, .nav-tabs li a, #player-tabs a'
          )
        );

        for (const el of elements) {
          const name = el.textContent?.trim() || '';
          const href = el.getAttribute('href') || el.getAttribute('data-href') || '';
          if (name && !seen.has(name)) {
            seen.add(name);
            servers.push({
              serverName: name,
              label: name,
              url: href.startsWith('http') ? href : href ? new URL(href, window.location.href).toString() : '',
            });
          }
        }
        return servers;
      });

      if (requestedServer && serverList.length > 0) {
        await page.evaluate((target) => {
          const buttons = Array.from(
            document.querySelectorAll(
              '#server-list a, .tab-server a, .server-item, .nav-tabs li a, #player-tabs a'
            )
          );
          const found = buttons.find((btn) =>
            btn.textContent?.toLowerCase().includes(target.toLowerCase())
          ) as HTMLElement | undefined;
          if (found) found.click();
        }, requestedServer);
        await page.waitForTimeout(2000);
      }

      let finalIframe = '';
      const iframeElements = await page.$$(
        '#player iframe, #embed-player iframe, .player-embed iframe, iframe[src*="player"], iframe[src*="embed"], iframe'
      );

      for (const el of iframeElements) {
        const src = await el.getAttribute('src');
        if (src && isValidPlayerIframe(src)) {
          finalIframe = src;
          break;
        }
      }

      if (finalIframe && !seenStreams.has(finalIframe)) {
        seenStreams.add(finalIframe);
        capturedStreams.push({
          server: requestedServer || 'Default Server',
          url: finalIframe,
          type: detectStreamType(finalIframe),
        });
      }

      const players: MoviePlayerItem[] = capturedStreams.map((s) => ({
        provider: s.server,
        url: s.url,
      }));

      const videoSources = capturedStreams.map((s) => ({
        label: s.server,
        file: s.url,
        type: s.type,
      }));

      const primaryStream = directStreamUrl || finalIframe || capturedStreams[0]?.url || '';

      return {
        title,
        slug,
        thumb: toAbsoluteUrl(thumb, targetUrl),
        stream_url: primaryStream,
        iframe: finalIframe,
        servers: serverList,
        serverList,
        players,
        streams: capturedStreams,
        video_sources: videoSources,
        originalUrl: targetUrl,
      };
    },
    { blockImages: false }
  );
}
