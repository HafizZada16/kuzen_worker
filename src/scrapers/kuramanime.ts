import type { Page } from 'playwright';
import { withPage } from '../browser.js';
import {
  type ScrapeOptions,
  type ScrapeResult,
  type ServerListItem,
  type StreamItem,
  type StreamType,
  ScraperError,
} from '../types.js';

const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Mendeteksi tipe stream berdasarkan URL
 */
function detectStreamType(url: string): StreamType {
  const lowercaseUrl = url.toLowerCase();
  if (lowercaseUrl.includes('.m3u8') || lowercaseUrl.includes('/hls/')) {
    return 'hls';
  }
  if (
    lowercaseUrl.includes('filemoon') ||
    lowercaseUrl.includes('bysezejataos') ||
    lowercaseUrl.includes('dood') ||
    lowercaseUrl.includes('playmogo') ||
    lowercaseUrl.includes('mega.nz') ||
    lowercaseUrl.includes('/e/') ||
    lowercaseUrl.includes('/embed')
  ) {
    return 'iframe';
  }
  if (lowercaseUrl.includes('.mp4') || lowercaseUrl.includes('.webm')) {
    return 'mp4';
  }
  return 'direct';
}

/**
 * Normalisasi format nama server untuk tampilan seragam api_kuzen
 * Contoh: "Kuramadrive (720p)", "FileMoon", "DoodStream"
 */
function formatServerDisplayName(rawName: string, size?: string): string {
  const clean = rawName.trim().toLowerCase();
  let base = 'Server';

  if (clean.includes('kuramadrive') || clean.includes('r2.cloudflarestorage.com')) {
    base = 'Kuramadrive';
  } else if (clean.includes('filemoon') || clean.includes('bysezejataos')) {
    base = 'FileMoon';
  } else if (clean.includes('dood') || clean.includes('playmogo')) {
    base = 'DoodStream';
  } else if (clean.includes('mega')) {
    base = 'MEGA';
  } else if (clean.includes('archive')) {
    base = 'Archive';
  } else if (clean.includes('mp4upload')) {
    base = 'Mp4Upload';
  } else {
    base = rawName.trim().split('—')[0].trim() || 'Server';
  }

  if (size) {
    return `${base} (${size}p)`;
  }
  return base;
}

/**
 * Normalisasi server key slug (misal: "kuramadrive_720p", "filemoon")
 */
function normalizeServerKey(rawName: string, size?: string): string {
  const clean = rawName.trim().toLowerCase();
  let base = 'server';

  if (clean.includes('kuramadrive') || clean.includes('r2.cloudflarestorage.com')) {
    base = 'kuramadrive';
  } else if (clean.includes('filemoon') || clean.includes('bysezejataos')) {
    base = 'filemoon';
  } else if (clean.includes('dood') || clean.includes('playmogo')) {
    base = 'doodstream';
  } else if (clean.includes('mega')) {
    base = 'mega';
  } else {
    base = clean.replace(/[^a-z0-9_-]/g, '') || 'server';
  }

  if (size && !base.includes(size)) {
    return `${base}_${size}p`;
  }
  return base;
}

/**
 * Memeriksa apakah URL iframe adalah video player (bukan chat atau widget pihak ketiga)
 */
function isValidPlayerIframe(url: string): boolean {
  if (!url || !url.startsWith('http')) return false;
  const lower = url.toLowerCase();
  if (
    lower.includes('kuramachat.com') ||
    lower.includes('chat/') ||
    lower.includes('disqus') ||
    lower.includes('about:blank') ||
    lower.includes('google') ||
    lower.includes('facebook')
  ) {
    return false;
  }
  return true;
}

/**
 * Memeriksa apakah halaman tertahan oleh Cloudflare challenge / turnstile
 */
async function checkCloudflareChallenge(page: Page): Promise<boolean> {
  try {
    const title = await page.title();
    if (
      title.includes('Just a moment...') ||
      title.includes('Attention Required!') ||
      title.includes('Cloudflare')
    ) {
      return true;
    }

    const cfElement = await page.$(
      '#challenge-running, #cf-challenge-running, .ray-id, iframe[src*="challenges.cloudflare.com"]'
    );
    return cfElement !== null;
  } catch {
    return false;
  }
}

/**
 * Trigger perubahan opsi server pada dropdown #changeServer
 */
async function triggerServerChange(page: Page, serverValue: string): Promise<void> {
  await page.evaluate((val) => {
    const el = document.querySelector<HTMLSelectElement>('#changeServer');
    if (el) {
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const win = window as any;
      if (win.$ || win.jQuery) {
        (win.$ || win.jQuery)(el).trigger('change');
      }
    }
  }, serverValue);
}

/**
 * Ekstraktor stream video utama untuk Kuramanime
 */
export async function scrapeKuramanime(options: ScrapeOptions): Promise<ScrapeResult> {
  const { url, server: requestedServer, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (!url || !url.startsWith('http')) {
    throw new ScraperError('Invalid URL provided. Must be a valid HTTP(S) URL.', 400, 'INVALID_URL');
  }

  const originUrl = new URL(url).origin;

  // Ekstrak anime slug dari URL
  // Contoh: https://v20.kuramanime.ing/anime/5256/tensei-goblin-dakedo-shitsumon-aru/episode/6 -> tensei-goblin-dakedo-shitsumon-aru
  const animeSlugMatch = url.match(/\/anime\/(?:\d+\/)?([^/?#]+)/i);
  const animeSlug = animeSlugMatch ? animeSlugMatch[1] : '';

  return await withPage(
    async (page) => {
      const interceptedStreams = new Map<string, { server: string; url: string; type: StreamType }>();

      // 1. Network Interceptor untuk memonitor request video manifest & embed player
      page.on('response', async (response) => {
        try {
          const reqUrl = response.url();
          const contentType = response.headers()['content-type'] || '';
          const status = response.status();

          if (status >= 200 && status < 400) {
            // Cek file manifest HLS / m3u8
            if (
              reqUrl.includes('.m3u8') ||
              contentType.includes('application/vnd.apple.mpegurl') ||
              contentType.includes('application/x-mpegurl')
            ) {
              const serverKey = reqUrl.includes('kuramadrive') ? 'Kuramadrive' : 'HLS Stream';
              if (!interceptedStreams.has(reqUrl)) {
                interceptedStreams.set(reqUrl, {
                  server: serverKey,
                  url: reqUrl,
                  type: 'hls',
                });
              }
            }

            // Cek embed domain mirror (FileMoon, DoodStream, Mega)
            if (
              (reqUrl.includes('filemoon.') ||
                reqUrl.includes('bysezejataos.') ||
                reqUrl.includes('dood.') ||
                reqUrl.includes('playmogo.') ||
                reqUrl.includes('mega.nz/embed')) &&
              isValidPlayerIframe(reqUrl)
            ) {
              const serverName = formatServerDisplayName(reqUrl);
              if (!interceptedStreams.has(reqUrl)) {
                interceptedStreams.set(reqUrl, {
                  server: serverName,
                  url: reqUrl,
                  type: 'iframe',
                });
              }
            }
          }
        } catch {
          // Abaikan error pada response listener
        }
      });

      // 2. Set timeout maksimal untuk seluruh proses
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new ScraperError(
              `Request timed out after ${timeoutMs / 1000}s while loading Kuramanime stream.`,
              504,
              'SCRAPE_TIMEOUT'
            )
          );
        }, timeoutMs);
      });

      const scrapeTask = async (): Promise<ScrapeResult> => {
        console.log(`[Kuramanime] Navigating to ${url}...`);

        try {
          await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: timeoutMs,
          });
        } catch (err: unknown) {
          const errMessage = err instanceof Error ? err.message : String(err);
          if (errMessage.includes('Timeout')) {
            throw new ScraperError(
              `Timeout navigating to Kuramanime page (${timeoutMs / 1000}s).`,
              504,
              'SCRAPE_TIMEOUT'
            );
          }
          throw new ScraperError(`Failed to load page: ${errMessage}`, 422, 'PAGE_LOAD_FAILED');
        }

        // Cek Cloudflare challenge
        const isBlocked = await checkCloudflareChallenge(page);
        if (isBlocked) {
          throw new ScraperError(
            'Cloudflare challenge detected. Request could not bypass bot verification.',
            422,
            'CLOUDFLARE_CHALLENGE'
          );
        }

        // 3. Ekstrak Metadata (Title & Episode)
        const metadata = await page.evaluate(() => {
          const rawTitle =
            document.querySelector('h1.entry-title')?.textContent ||
            document.querySelector('.episode-details h1')?.textContent ||
            document.querySelector('h1')?.textContent ||
            document.title ||
            '';

          // Ekstrak episode
          const epMatch =
            rawTitle.match(/Episode\s+(\d+(\.\d+)?)/i) ||
            window.location.href.match(/episode\/(\d+)/i);
          const episode = epMatch ? epMatch[1] : '1';

          // Bersihkan title
          let cleanTitle = rawTitle
            .replace(/Nonton Anime/gi, '')
            .replace(/Subtitle Indonesia/gi, '')
            .replace(/Kuramanime/gi, '')
            .replace(/\(Episode\s+\d+(\.\d+)?\)/gi, '')
            .replace(/Episode\s+\d+(\.\d+)?/gi, '')
            .replace(/[\n\r\t]/g, ' ')
            .replace(/[-–—]/g, ' ')
            .trim();

          // Bersihkan kurung kosong dan rapikan spasi
          cleanTitle = cleanTitle
            .replace(/\(\s*\)/g, '')
            .replace(/\[\s*\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();

          return {
            title: cleanTitle || rawTitle.trim(),
            episode,
          };
        });

        // 4. Tunggu container player (#animeVideoPlayer)
        console.log('[Kuramanime] Waiting for #animeVideoPlayer...');
        try {
          await page.waitForSelector('#animeVideoPlayer, .player-area', {
            timeout: 10_000,
          });
        } catch {
          console.warn('[Kuramanime] Selector #animeVideoPlayer not immediately found, proceeding...');
        }

        // Beri waktu script klien (leviathan.js) menginisialisasi player
        await page.waitForTimeout(2000);

        // 5. Periksa opsi server mirror pada elemen #changeServer
        const availableServers = await page.evaluate(() => {
          const select = document.querySelector<HTMLSelectElement>('#changeServer');
          if (!select) return [];

          return Array.from(select.options).map((opt) => ({
            value: opt.value,
            text: opt.textContent?.trim() || opt.value,
            selected: opt.selected,
          }));
        });

        console.log(
          `[Kuramanime] Available servers detected:`,
          availableServers.map((s) => s.text)
        );

        // Helper untuk mengekstrak stream dari DOM saat ini
        const extractCurrentStreamsFromDom = async () => {
          return await page.evaluate(() => {
            const results: { serverName: string; url: string; size?: string; isIframe: boolean }[] = [];

            // Ekstrak iframe valid
            const iframes = document.querySelectorAll<HTMLIFrameElement>(
              '#animeVideoPlayer iframe, .player-area iframe, iframe'
            );
            iframes.forEach((iframe) => {
              const src = iframe.src || iframe.getAttribute('data-src') || '';
              if (
                src &&
                src.startsWith('http') &&
                !src.includes('about:blank') &&
                !src.includes('kuramachat.com') &&
                !src.includes('chat/')
              ) {
                results.push({
                  serverName: 'Mirror Player',
                  url: src,
                  isIframe: true,
                });
              }
            });

            // Ekstrak tag <video> & elemen <source> di dalamnya
            const videos = document.querySelectorAll<HTMLVideoElement>(
              '#animeVideoPlayer video, .player-area video, video'
            );
            videos.forEach((vid) => {
              const sources = vid.querySelectorAll<HTMLSourceElement>('source');
              if (sources.length > 0) {
                sources.forEach((s) => {
                  if (s.src && s.src.startsWith('http')) {
                    const size = s.getAttribute('size') || undefined;
                    results.push({
                      serverName: 'Kuramadrive',
                      url: s.src,
                      size,
                      isIframe: false,
                    });
                  }
                });
              } else {
                const src = vid.src || vid.currentSrc;
                if (src && src.startsWith('http')) {
                  results.push({
                    serverName: 'Kuramadrive',
                    url: src,
                    isIframe: false,
                  });
                }
              }
            });

            return results;
          });
        };

        const serverListMap = new Map<string, ServerListItem>();
        const streamsMap = new Map<string, StreamItem>();

        // Masukkan stream dari default player (biasanya Kuramadrive dengan multi-resolusi)
        const defaultDomStreams = await extractCurrentStreamsFromDom();
        for (const item of defaultDomStreams) {
          const displayName = formatServerDisplayName(item.serverName, item.size);
          const serverKey = normalizeServerKey(item.serverName, item.size);
          const streamType = detectStreamType(item.url);

          serverListMap.set(item.url, {
            serverName: displayName,
            url: item.url,
          });

          streamsMap.set(item.url, {
            server: serverKey,
            url: item.url,
            type: streamType,
          });
        }

        // Jika user meminta server tertentu
        if (requestedServer && availableServers.length > 0) {
          const target = availableServers.find(
            (s) =>
              s.text.toLowerCase().includes(requestedServer.toLowerCase()) ||
              s.value.toLowerCase().includes(requestedServer.toLowerCase())
          );

          if (target) {
            console.log(`[Kuramanime] Switching to requested server: ${target.text} (${target.value})`);
            await triggerServerChange(page, target.value);
            await page.waitForTimeout(2000);

            const switchedStreams = await extractCurrentStreamsFromDom();
            for (const item of switchedStreams) {
              const displayName = formatServerDisplayName(target.text, item.size);
              const serverKey = normalizeServerKey(target.value, item.size);

              serverListMap.set(item.url, {
                serverName: displayName,
                url: item.url,
              });

              streamsMap.set(item.url, {
                server: serverKey,
                url: item.url,
                type: detectStreamType(item.url),
              });
            }
          }
        } else if (availableServers.length > 1) {
          // Ambil mirror tambahan yang populer (FileMoon, DoodStream, MEGA)
          const mirrorCandidates = availableServers.filter(
            (s) => !s.selected && (s.value === 'filemoon' || s.value === 'doodstream' || s.value === 'mega')
          );

          for (const mirror of mirrorCandidates.slice(0, 2)) {
            console.log(`[Kuramanime] Fetching mirror: ${mirror.text} (${mirror.value})...`);
            await triggerServerChange(page, mirror.value);
            await page.waitForTimeout(1800);

            const mirrorStreams = await extractCurrentStreamsFromDom();
            for (const item of mirrorStreams) {
              if (isValidPlayerIframe(item.url)) {
                const displayName = formatServerDisplayName(mirror.text);
                const serverKey = normalizeServerKey(mirror.value);

                serverListMap.set(item.url, {
                  serverName: displayName,
                  url: item.url,
                });

                streamsMap.set(item.url, {
                  server: serverKey,
                  url: item.url,
                  type: detectStreamType(item.url),
                });
              }
            }
          }
        }

        // Masukkan data dari network interceptor yang valid jika belum terdaftar
        for (const item of interceptedStreams.values()) {
          if (!serverListMap.has(item.url) && isValidPlayerIframe(item.url)) {
            serverListMap.set(item.url, {
              serverName: item.server,
              url: item.url,
            });
            streamsMap.set(item.url, {
              server: normalizeServerKey(item.server),
              url: item.url,
              type: item.type,
            });
          }
        }

        const serverList = Array.from(serverListMap.values());
        const streams = Array.from(streamsMap.values());

        if (serverList.length === 0) {
          throw new ScraperError(
            'Failed to extract video stream. Player not mounted or stream protected.',
            422,
            'STREAM_NOT_FOUND'
          );
        }

        // Tentukan default iframe / stream URL untuk field `iframe`
        // Prioritaskan yang bertipe iframe mirror atau link pertama dari serverList
        const defaultIframe =
          streams.find((s) => s.type === 'iframe')?.url || serverList[0]?.url || '';

        return {
          title: metadata.title,
          episode: metadata.episode,
          slug: animeSlug,
          iframe: defaultIframe,
          serverList,
          streams,
        };
      };

      return await Promise.race([scrapeTask(), timeoutPromise]);
    },
    { referer: originUrl }
  );
}
