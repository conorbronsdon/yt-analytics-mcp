// Response shapes for the YouTube Analytics API v2 and the YouTube Data API v3.
// Only fields this server reads are typed; unknown extra fields are ignored.
//
// Docs: https://developers.google.com/youtube/analytics/reference/reports/query
//       https://developers.google.com/youtube/v3/docs/videos/list
//
// Every shape here was confirmed against a live 200 response on 2026-08-07.

/** One entry in `columnHeaders`. `columnType` is "DIMENSION" or "METRIC". */
export interface ColumnHeader {
  name: string;
  columnType?: string;
  dataType?: string;
}

/**
 * The `youtubeAnalytics#resultTable` envelope.
 *
 * `rows` is positional: each row is an array whose entries line up with
 * `columnHeaders` by index. Nothing in the payload names the values, which is
 * why `shape.ts` zips them into objects before anything else touches them.
 */
export interface ReportResponse {
  kind?: string;
  columnHeaders?: ColumnHeader[];
  rows?: (string | number)[][];
}

// --- YouTube Data API v3 ---

export interface VideoSnippet {
  title?: string;
  publishedAt?: string;
  channelId?: string;
  channelTitle?: string;
}

export interface VideoItem {
  id?: string;
  snippet?: VideoSnippet;
  contentDetails?: { duration?: string };
}

export interface VideoListResponse {
  items?: VideoItem[];
}

export interface ChannelItem {
  id?: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    publishedAt?: string;
    description?: string;
  };
  statistics?: {
    viewCount?: string;
    subscriberCount?: string;
    videoCount?: string;
  };
}

export interface ChannelListResponse {
  items?: ChannelItem[];
}
