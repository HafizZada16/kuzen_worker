import type { Page } from 'playwright';
import { type StreamType, ScraperError } from '../types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Ekstraksi slug dari URL (contoh: https://tv12.lk21official.cc/mortal-kombat-2021/ -> mortal-kombat-2021)
 */
export function extractSlug(url: string, baseUrl?: string): string {
  if (!url) return '';
  try {
    const full = url.startsWith('http') ? url : baseUrl ? new URL(url, baseUrl).toString() : url;
    const pathname = new URL(full).pathname;
    return pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
  } catch {
    return url.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
  }
}

/**
 * Membersihkan awalan "Nonton" dan akhiran "Sub Indo" agar seragam dengan api_kuzen
 */
export function cleanMovieTitle(title: string): string {
  if (!title) return '';
  return title
    .replace(/^nonton\s+/i, '')
    .replace(/\s+sub\s+indo$/i, '')
    .replace(/\s+subtitle\s+indonesia$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mendeteksi tipe stream berdasarkan pola URL
 */
export function detectStreamType(url: string): StreamType {
  const lowercaseUrl = url.toLowerCase();
  if (lowercaseUrl.includes('.m3u8') || lowercaseUrl.includes('/hls/')) {
    return 'hls';
  }
  if (
    lowercaseUrl.includes('filemoon') ||
    lowercaseUrl.includes('bysezejataos') ||
    lowercaseUrl.includes('dood') ||
    lowercaseUrl.includes('playmogo') ||
    lowercaseUrl.includes('streamwish') ||
    lowercaseUrl.includes('vidhide') ||
    lowercaseUrl.includes('turbovid') ||
    lowercaseUrl.includes('mixdrop') ||
    lowercaseUrl.includes('fembed') ||
    lowercaseUrl.includes('streamtape') ||
    lowercaseUrl.includes('playeriframe') ||
    lowercaseUrl.includes('windowpopup') ||
    lowercaseUrl.includes('mega.nz') ||
    lowercaseUrl.includes('/e/') ||
    lowercaseUrl.includes('/embed') ||
    lowercaseUrl.includes('embed')
  ) {
    return 'iframe';
  }
  if (lowercaseUrl.includes('.mp4') || lowercaseUrl.includes('.webm')) {
    return 'mp4';
  }
  return 'direct';
}

/**
 * Validasi apakah URL iframe merupakan video player (bukan iklan atau widget)
 */
export function isValidPlayerIframe(url: string): boolean {
  if (!url || !url.startsWith('http')) return false;
  const lower = url.toLowerCase();
  if (
    lower.includes('about:blank') ||
    lower.includes('google') ||
    lower.includes('facebook') ||
    lower.includes('histats') ||
    lower.includes('disqus') ||
    lower.includes('popcash') ||
    lower.includes('popads') ||
    lower.includes('adnxs')
  ) {
    return false;
  }
  return true;
}

/**
 * Memeriksa apakah halaman tertahan oleh Cloudflare challenge
 */
export async function checkCloudflareChallenge(page: Page): Promise<boolean> {
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
 * Helper untuk menunggu jika Cloudflare JS challenge sedang berjalan
 */
export async function waitIfCloudflare(page: Page, maxWaitMs = 8_000): Promise<void> {
  if (await checkCloudflareChallenge(page)) {
    console.log('[Scraper] Cloudflare challenge detected, waiting for automatic resolution...');
    await page.waitForTimeout(maxWaitMs);
    if (await checkCloudflareChallenge(page)) {
      throw new ScraperError(
        'Cloudflare bot challenge could not be resolved automatically.',
        503,
        'CLOUDFLARE_BLOCKED'
      );
    }
  }
}

/**
 * Membersihkan spasi dan baris baru berlebih
 */
export function cleanText(text?: string | null): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}
