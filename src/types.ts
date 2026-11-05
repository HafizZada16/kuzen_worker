export type StreamType = 'hls' | 'iframe' | 'direct' | 'mp4';

export interface ServerListItem {
  serverName: string;
  label?: string;
  url: string;
}

export interface StreamItem {
  server: string;
  url: string;
  type: StreamType;
}

export interface MoviePlayerItem {
  provider: string;
  url: string;
}

export interface ScrapeResult {
  title: string;
  episode: string;
  slug?: string;
  iframe: string;
  serverList: ServerListItem[];
  streams: StreamItem[];
}

export interface MovieListItem {
  title: string;
  slug: string;
  url: string;
  thumb: string;
  poster: string;
  rating?: string;
  quality?: string;
  year?: string;
  type?: 'movie' | 'series';
}

export interface PaginationResult<T> {
  page: number;
  hasMore: boolean;
  items: T[];
}

export interface MovieEpisodeItem {
  episode: string;
  title: string;
  slug: string;
  url: string;
  seasonNumber?: string;
}

export interface MovieDetail {
  title: string;
  slug: string;
  thumb: string;
  poster: string;
  backdrop?: string;
  synopsis: string;
  rating?: string;
  year?: string;
  release?: string;
  duration?: string;
  genres: string[];
  info: Record<string, string>;
  players: MoviePlayerItem[];
  streams: StreamItem[];
  serverList: ServerListItem[];
  iframe?: string;
  stream_url?: string;
  episodes?: MovieEpisodeItem[] | null;
  trailerUrl?: string;
  originalUrl?: string;
  type: 'movie' | 'series';
}

export interface MovieStreamResult {
  title: string;
  slug?: string;
  thumb?: string;
  stream_url: string;
  iframe: string;
  servers: ServerListItem[];
  serverList: ServerListItem[];
  players: MoviePlayerItem[];
  streams: StreamItem[];
  video_sources: Array<{ label: string; file: string; type: string }>;
  originalUrl?: string;
}

export interface ApiSuccessResponse<T> {
  status: 'success';
  data: T;
  page?: number;
  hasMore?: boolean;
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
