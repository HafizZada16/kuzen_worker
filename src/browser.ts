import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

let browserInstance: Browser | null = null;
let isInitializing = false;
let initPromise: Promise<Browser> | null = null;

const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-software-rasterizer',
  '--mute-audio',
];

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Mendapatkan atau menginisialisasi singleton browser instance.
 */
export async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  if (isInitializing && initPromise) {
    return initPromise;
  }

  isInitializing = true;
  initPromise = (async () => {
    try {
      console.log('[Browser] Launching Chromium instance...');
      const browser = await chromium.launch({
        headless: true,
        args: CHROMIUM_ARGS,
      });

      browser.on('disconnected', () => {
        console.warn('[Browser] Chromium instance disconnected.');
        browserInstance = null;
      });

      browserInstance = browser;
      return browser;
    } finally {
      isInitializing = false;
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Eksekusi task scraper di dalam isolated browser page dengan lifecycle otomatis.
 * Mencegah memory leak dengan memastikan context dan page selalu ditutup di blok finally.
 */
export async function withPage<T>(
  task: (page: Page, context: BrowserContext) => Promise<T>,
  options?: { referer?: string }
): Promise<T> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
    extraHTTPHeaders: {
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      ...(options?.referer ? { Referer: options.referer } : {}),
    },
  });

  const page = await context.newPage();

  // Optimasi memory: blokir resource yang tidak diperlukan (iklan, font, analitik luar)
  await page.route('**/*', (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const url = request.url();

    // Jangan blokir script, document, xhr/fetch, atau stream playlist
    if (url.includes('.m3u8') || url.includes('/stream') || url.includes('leviathan')) {
      return route.continue();
    }

    // Blokir tracker pihak ketiga umum & font berat
    if (
      resourceType === 'font' ||
      url.includes('google-analytics') ||
      url.includes('googletagmanager') ||
      url.includes('histats') ||
      url.includes('disqus') ||
      url.includes('popads') ||
      url.includes('adroll')
    ) {
      return route.abort();
    }

    return route.continue();
  });

  try {
    return await task(page, context);
  } finally {
    try {
      await page.close();
    } catch (err) {
      console.error('[Browser] Failed to close page:', err);
    }
    try {
      await context.close();
    } catch (err) {
      console.error('[Browser] Failed to close context:', err);
    }
  }
}

/**
 * Menutup browser instance saat shutdown aplikasi
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    console.log('[Browser] Closing Chromium instance...');
    try {
      await browserInstance.close();
    } catch (err) {
      console.error('[Browser] Error closing browser:', err);
    } finally {
      browserInstance = null;
    }
  }
}

