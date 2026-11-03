export type StreamType = 'hls' | 'iframe' | 'direct' | 'mp4';

export interface ServerListItem {
  serverName: string;
  url: string;
}

export interface StreamItem {
  server: string;
  url: string;
  type: StreamType;
}

export interface ScrapeResult {
  title: string;
  episode: string;
  slug?: string;
  iframe: string;
  serverList: ServerListItem[];
  streams: StreamItem[];
}

export interface ApiSuccessResponse<T> {
  status: 'success';
  data: T;
}

export interface ApiErrorResponse {
  status: 'error';
  message: string;
  code?: string;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface ScrapeOptions {
  url: string;
  server?: string;
  timeoutMs?: number;
}

export class ScraperError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode: number = 422, code: string = 'SCRAPE_FAILED') {
    super(message);
    this.name = 'ScraperError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
