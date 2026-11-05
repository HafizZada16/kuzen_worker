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

export const DEFAULT_IDLIX_BASE_URL = 'https://z2.idlixku.com';

/**
 * Normalisasi URL relatif ke absolut
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
function resolveIdlixTargetUrl(
  input: string,
  type: 'movie' | 'series' = 'movie',
  baseUrl: string = DEFAULT_IDLIX_BASE_URL
): string {
  if (!input) return '';
  if (input.startsWith('http://') || input.startsWith('https://')) {
    return input;
  }
  const cleanSlug = input.replace(/^\/+|\/+$/g, '');
  if (cleanSlug.startsWith('movie/') || cleanSlug.startsWith('series/') || cleanSlug.startsWith('tvshows/')) {
    return `${baseUrl.replace(/\/$/, '')}/${cleanSlug}/`;
  }
  const path = type === 'series' ? 'series' : 'movie';
  return `${baseUrl.replace(/\/$/, '')}/${path}/${cleanSlug}/`;
}

/**
 * Scraper daftar film & serial terbaru dari IDLIX (DooPlay CMS)
 */
export async function scrapeIdlixLatest(
  pageNumber: number = 1,
  type: 'movie' | 'series' = 'movie',
  baseUrl: string = DEFAULT_IDLIX_BASE_URL
): Promise<PaginationResult<MovieListItem>> {
  const path = type === 'series' ? 'series' : 'movie';
  const targetUrl =
    pageNumber === 1
      ? `${baseUrl.replace(/\/$/, '')}/${path}/`
      : `${baseUrl.replace(/\/$/, '')}/${path}/page/${pageNumber}/`;

  return withPage(
    async (page: Page) => {
      console.log(`[IDLIX] Scraping latest ${type} from: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      await page.waitForSelector('.items, article.item, #archive-content', {
        timeout: 10_000,
      }).catch(() => null);

      const result = await page.evaluate(
        ({ base, currentPage, defaultType }) => {
          const items: any[] = [];
          const seenSlugs = new Set<string>();

          const elements = Array.from(
            document.querySelectorAll('.items article.item, article.item, .items .poster')
          );

          for (const el of elements) {
            const linkEl =
              el.querySelector<HTMLAnchorElement>('.poster a, .data h3 a, a[href*="/"]') ||
              (el.tagName === 'A' ? (el as HTMLAnchorElement) : null);
            if (!linkEl) continue;

            const href = linkEl.getAttribute('href') || '';
            if (!href || href.includes('/genre/') || href.includes('/country/') || href.includes('/year/')) {
              continue;
            }

            const fullUrl = href.startsWith('http') ? href : new URL(href, base).toString();
            const u = new URL(fullUrl);
            const slug = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
            if (!slug || seenSlugs.has(slug)) continue;
            seenSlugs.add(slug);

            const titleEl = el.querySelector('.data h3, h3, .title, a[title]');
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

            const ratingEl = el.querySelector('.rating, .star, .dt_rating_vgs');
            const rating = ratingEl?.textContent?.replace(/[^\d.]/g, '').trim() || undefined;

            const qualityEl = el.querySelector('.quality, .featu');
            const quality = qualityEl?.textContent?.trim() || undefined;

            const yearEl = el.querySelector('.data span, .year');
            const yearMatch = (yearEl?.textContent || el.textContent)?.match(/\b(19\d\d|20\d\d)\b/);
            const year = yearMatch ? yearMatch[1] : undefined;

            const isSeries =
              el.classList.contains('tvshows') ||
              fullUrl.includes('/series/') ||
              fullUrl.includes('/tvshows/');

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
              type: isSeries ? 'series' : defaultType,
            });
          }

          const nextBtn = document.querySelector(
            '.pagination .next, a.arrow_pag, .page-numbers.next, a[rel="next"]'
          );
          return {
            page: currentPage,
            hasMore: nextBtn !== null || items.length >= 12,
            items,
          };
        },
        { base: baseUrl, currentPage: pageNumber, defaultType: type }
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
  const targetUrl =
    pageNumber === 1
      ? `${baseUrl.replace(/\/$/, '')}/?s=${encodedQuery}`
      : `${baseUrl.replace(/\/$/, '')}/page/${pageNumber}/?s=${encodedQuery}`;

  return withPage(
    async (page: Page) => {
      console.log(`[IDLIX] Searching "${query}" from: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      await page.waitForSelector('.result-item, .items article, #archive-content', {
        timeout: 10_000,
      }).catch(() => null);

      const result = await page.evaluate(
        ({ base, currentPage }) => {
          const items: any[] = [];
          const seenSlugs = new Set<string>();

          const elements = Array.from(
            document.querySelectorAll('.result-item article, .items article.item, .search-page article')
          );

          for (const el of elements) {
            const linkEl =
              el.querySelector<HTMLAnchorElement>('.title a, .details .title a, .image a, a[href*="/"]') ||
              el.closest('a');
            if (!linkEl) continue;

            const href = linkEl.getAttribute('href') || '';
            if (!href || href.includes('/genre/') || href.includes('/tag/')) continue;

            const fullUrl = href.startsWith('http') ? href : new URL(href, base).toString();
            const u = new URL(fullUrl);
            const slug = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
            if (!slug || seenSlugs.has(slug)) continue;
            seenSlugs.add(slug);

            const rawTitle =
              linkEl.textContent?.trim() ||
              el.querySelector('.title, h3, h2')?.textContent?.trim() ||
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

            const ratingEl = el.querySelector('.rating, .star');
            const rating = ratingEl?.textContent?.replace(/[^\d.]/g, '').trim() || undefined;

            const yearMatch = el.textContent?.match(/\b(19\d\d|20\d\d)\b/);
            const year = yearMatch ? yearMatch[1] : undefined;

            const isSeries = fullUrl.includes('/series/') || fullUrl.includes('/tvshows/');
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
              year,
              type: isSeries ? 'series' : 'movie',
            });
          }

          const nextBtn = document.querySelector(
            '.pagination .next, a.arrow_pag, .page-numbers.next, a[rel="next"]'
          );
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
 * Scraper detail film / serial IDLIX (DooPlay CMS)
 */
export async function scrapeIdlixDetail(
  urlOrSlug: string,
  type: 'movie' | 'series' = 'movie',
  baseUrl: string = DEFAULT_IDLIX_BASE_URL
): Promise<MovieDetail> {
  const targetUrl = resolveIdlixTargetUrl(urlOrSlug, type, baseUrl);

  return withPage(
    async (page: Page) => {
      console.log(`[IDLIX] Scraping movie/series detail from: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      await page.waitForSelector('.sheader, #info, h1, .wp-content', {
        timeout: 10_000,
      }).catch(() => null);

      const parsed = await page.evaluate(({ base, target }) => {
        const titleEl = document.querySelector('.sheader .data h1, h1.entry-title, h1');
        const rawTitle = titleEl?.textContent?.trim() || '';
        const title = rawTitle
          .replace(/^nonton\s+/i, '')
          .replace(/\s+sub\s+indo$/i, '')
          .replace(/\s+subtitle\s+indonesia$/i, '')
          .trim();

        const originalTitleEl = document.querySelector('.sheader .data h2, .extra .original-title');
        const originalTitle = originalTitleEl?.textContent?.trim() || undefined;

        // Sinopsis
        const synopsisEl = document.querySelector(
          '.wp-content p, #info .wp-content, .entry-content p, #synopsis'
        );
        const synopsis = synopsisEl?.textContent?.trim() || '';

        // Poster / Thumb
        const posterEl = document.querySelector<HTMLImageElement>(
          '.sheader .poster img, .poster img, meta[property="og:image"]'
        );
        const poster =
          posterEl?.getAttribute('data-src') ||
          posterEl?.getAttribute('src') ||
          posterEl?.getAttribute('content') ||
          '';

        // Backdrop
        const backdropEl = document.querySelector<HTMLImageElement>('.sbackdrop img, .backdrop img');
        const backdrop = backdropEl?.getAttribute('data-src') || backdropEl?.getAttribute('src') || undefined;

        // Info Key-Value Object (sesuai format api_kuzen)
        const info: Record<string, string> = {};

        const ratingEl = document.querySelector(
          '.star-score, .dt_rating_vgs, .rating, span[itemprop="ratingValue"]'
        );
        const rating = ratingEl?.textContent?.replace(/[^\d.]/g, '').trim() || undefined;
        if (rating) info['Rating'] = rating;

        const dateEl = document.querySelector('.extra .date, .sheader .date, span.date');
        const yearMatch =
          (dateEl?.textContent || document.body.textContent)?.match(/\b(19\d\d|20\d\d)\b/);
        const year = yearMatch ? yearMatch[1] : undefined;
        if (year) info['Year'] = year;

        const runtimeEl = document.querySelector('.extra .runtime, span.runtime');
        const duration = runtimeEl?.textContent?.trim() || undefined;
        if (duration) info['Duration'] = duration;

        const countryElements = Array.from(document.querySelectorAll('.country a, a[href*="/country/"]'));
        const countries = Array.from(new Set(countryElements.map((c) => c.textContent?.trim() || '').filter(Boolean)));
        if (countries.length > 0) info['Country'] = countries.join(', ');

        const directorElements = Array.from(
          document.querySelectorAll('.sheader a[href*="/director/"], a[href*="/director/"]')
        );
        const directors = Array.from(new Set(directorElements.map((d) => d.textContent?.trim() || '').filter(Boolean)));
        if (directors.length > 0) info['Director'] = directors.join(', ');

        const castElements = Array.from(
          document.querySelectorAll('.persons .person .name a, a[href*="/cast/"]')
        );
        const casts = Array.from(new Set(castElements.map((c) => c.textContent?.trim() || '').filter(Boolean)));
        if (casts.length > 0) info['Cast'] = casts.join(', ');

        // Genres
        const genreElements = Array.from(document.querySelectorAll('.sgenres a, a[href*="/genre/"]'));
        const genres = Array.from(new Set(genreElements.map((g) => g.textContent?.trim() || '').filter(Boolean)));
        if (genres.length > 0) info['Genre'] = genres.join(', ');

        // Trailer
        const trailerIframe = document.querySelector<HTMLIFrameElement>(
          '#trailer iframe, iframe[src*="youtube.com"]'
        );
        const trailerUrl = trailerIframe?.getAttribute('src') || undefined;

        // Players & Server List
        const players: Array<{ provider: string; url: string }> = [];
        const serverList: Array<{ serverName: string; label: string; url: string }> = [];
        const seenPlayerUrls = new Set<string>();

        const activeIframes = Array.from(
          document.querySelectorAll('#playerep iframe, #player2 iframe, .embed-responsive iframe, iframe')
        );
        for (const frame of activeIframes) {
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

        const serverTabs = Array.from(
          document.querySelectorAll('#playeroptionsul li, .playex li, .sourceslist li')
        );
        for (const tab of serverTabs) {
          const sName =
            tab.querySelector('.title, .server')?.textContent?.trim() || tab.textContent?.trim() || '';
          const post = tab.getAttribute('data-post') || '';
          const nume = tab.getAttribute('data-nume') || '';
          const sType = tab.getAttribute('data-type') || '';
          const id = tab.getAttribute('id') || '';

          if (sName) {
            serverList.push({
              serverName: sName,
              label: sName,
              url: `post=${post}&nume=${nume}&type=${sType}&id=${id}`,
            });
          }
        }

        // Season & Episodes
        const episodes: any[] = [];
        const seasonBlocks = Array.from(document.querySelectorAll('#seasons .se-c, .se-c'));

        for (const seasonEl of seasonBlocks) {
          const seasonTitle =
            seasonEl.querySelector('.se-q span.title, .se-t')?.textContent?.trim() || '';
          const seasonMatch = seasonTitle.match(/season\s*(\d+)/i) || seasonTitle.match(/(\d+)/);
          const seasonNumber = seasonMatch ? seasonMatch[1] : undefined;

          const epItems = Array.from(seasonEl.querySelectorAll('.episodios li'));
          for (const ep of epItems) {
            const epLink = ep.querySelector<HTMLAnchorElement>('.episodios a, a');
            if (!epLink) continue;

            const epHref = epLink.getAttribute('href') || '';
            const epNum = ep.querySelector('.numerando')?.textContent?.trim() || '';
            const epTitle =
              epLink.textContent?.trim() ||
              ep.querySelector('.episodiotitle a')?.textContent?.trim() ||
              `Episode ${epNum}`;

            if (epHref) {
              const fullEpHref = epHref.startsWith('http') ? epHref : new URL(epHref, base).toString();
              const u = new URL(fullEpHref);
              const epSlug = u.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';

              episodes.push({
                episode: epNum || '1',
                title: epTitle,
                slug: epSlug,
                seasonNumber,
                url: fullEpHref,
              });
            }
          }
        }

        const isSeries =
          episodes.length > 0 ||
          target.includes('/series/') ||
          target.includes('/tvshows/');

        return {
          title,
          originalTitle,
          synopsis,
          poster,
          backdrop,
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
        backdrop: parsed.backdrop ? toAbsoluteUrl(parsed.backdrop, targetUrl) : undefined,
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
 * Scraper ekstraksi video stream & player DooPlay di IDLIX
 */
export async function scrapeIdlixStream(
  urlOrSlug: string,
  requestedServer?: string,
  type: 'movie' | 'series' = 'movie',
  baseUrl: string = DEFAULT_IDLIX_BASE_URL
): Promise<MovieStreamResult> {
  const targetUrl = resolveIdlixTargetUrl(urlOrSlug, type, baseUrl);

  return withPage(
    async (page: Page) => {
      console.log(`[IDLIX] Extracting stream from: ${targetUrl}`);

      const capturedStreams: StreamItem[] = [];
      const seenStreams = new Set<string>();

      page.on('response', async (response) => {
        try {
          const resUrl = response.url();
          const contentType = response.headers()['content-type'] || '';

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
              console.log('[IDLIX] Captured HLS Stream:', resUrl);
            }
          }
        } catch {}
      });

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      await waitIfCloudflare(page);

      const rawTitle = cleanText(
        (await page.$eval('.sheader .data h1, h1', (el) => el.textContent).catch(() => null)) ||
          (await page.title())
      );
      const title = cleanMovieTitle(rawTitle);
      const slug = extractSlug(targetUrl, baseUrl);

      const thumb = await page
        .evaluate(() => {
          const img = document.querySelector<HTMLImageElement>(
            '.sheader .poster img, .poster img, meta[property="og:image"]'
          );
          return img?.getAttribute('data-src') || img?.getAttribute('src') || img?.getAttribute('content') || '';
        })
        .catch(() => '');

      // Daftar server playeroptionsul (DooPlay tabs)
      const serverList: ServerListItem[] = await page.evaluate(() => {
        const servers: ServerListItem[] = [];
        const seen = new Set<string>();

        const elements = Array.from(
          document.querySelectorAll('#playeroptionsul li, .playex li, .sourceslist li')
        );

        for (const el of elements) {
          const name =
            el.querySelector('.title, .server')?.textContent?.trim() ||
            el.textContent?.trim() ||
            '';
          const post = el.getAttribute('data-post') || '';
          const nume = el.getAttribute('data-nume') || '';
          const sType = tabAttribute(el, 'data-type');
          const id = el.getAttribute('id') || '';

          function tabAttribute(element: Element, attr: string): string {
            return element.getAttribute(attr) || '';
          }

          if (name && !seen.has(name)) {
            seen.add(name);
            servers.push({
              serverName: name,
              label: name,
              url: `post=${post}&nume=${nume}&type=${sType}&id=${id}`,
            });
          }
        }
        return servers;
      });

      if (requestedServer && serverList.length > 0) {
        console.log(`[IDLIX] Switching to server: ${requestedServer}`);
        await page.evaluate((target) => {
          const list = Array.from(
            document.querySelectorAll('#playeroptionsul li, .playex li, .sourceslist li')
          );
          const found = list.find((el) =>
            el.textContent?.toLowerCase().includes(target.toLowerCase())
          ) as HTMLElement | undefined;
          if (found) found.click();
        }, requestedServer);
        await page.waitForTimeout(2000);
      }

      let finalIframe = '';
      const iframeSelectors = [
        '#playerep iframe',
        '#player2 iframe',
        '.embed-responsive iframe',
        '.player-content iframe',
        'iframe[src*="embed"]',
        'iframe[src*="player"]',
      ];

      for (const sel of iframeSelectors) {
        const iframeEl = await page.$(sel);
        if (iframeEl) {
          const src = await iframeEl.getAttribute('src');
          if (src && isValidPlayerIframe(src)) {
            finalIframe = src;
            break;
          }
        }
      }

      if (!finalIframe) {
        const allIframes = await page.$$('iframe');
        for (const frame of allIframes) {
          const src = await frame.getAttribute('src');
          if (src && isValidPlayerIframe(src)) {
            finalIframe = src;
            break;
          }
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

      return {
        title,
        slug,
        thumb: toAbsoluteUrl(thumb, targetUrl),
        stream_url: finalIframe || capturedStreams[0]?.url || '',
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
