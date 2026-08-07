import type { ReportResponse } from "./types.js";

/** Recursively drop null, undefined, and empty-string fields to save tokens. */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripNulls(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined || v === "") continue;
      out[k] = stripNulls(v);
    }
    return out as T;
  }
  return value;
}

export function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Turn the API's positional `rows` into named objects using `columnHeaders`.
 *
 * The raw payload is two parallel structures — a header list and rows of bare
 * values — with nothing tying a number to its metric except array position. An
 * agent handed that has to count columns to read a result, and miscounting is
 * silent. Zipping here means every tool downstream works with `{views: 437}`
 * instead of `row[1]`.
 *
 * Floats are rounded to 4 places: `audienceWatchRatio` comes back as
 * 0.73730000000000007 (observed live), and the trailing garbage is both noise
 * and tokens.
 */
export function toObjects(res: ReportResponse): Record<string, string | number>[] {
  const headers = res.columnHeaders ?? [];
  const names = headers.map((h) => h.name);
  return (res.rows ?? []).map((row) => {
    const out: Record<string, string | number> = {};
    names.forEach((name, i) => {
      const v = row[i];
      out[name] = typeof v === "number" && !Number.isInteger(v) ? round(v, 4) : v;
    });
    return out;
  });
}

/**
 * Whole-days difference between two YYYY-MM-DD dates, `later` minus `earlier`.
 *
 * Parsed as UTC midnight rather than through the local-time `Date` constructor:
 * YouTube reports days in the channel's own timezone as plain date strings, and
 * running the arithmetic in local time makes the answer depend on the machine's
 * TZ and on whether a DST boundary falls inside the range. UTC midnight is
 * stable everywhere, which matters because this number is the x-axis of the
 * episode-race view.
 */
export function daysBetween(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Add `n` whole days to a YYYY-MM-DD date, in UTC. Returns YYYY-MM-DD. */
export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** The date portion of an ISO 8601 timestamp, e.g. "2026-07-06T16:00:23Z". */
export function isoDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export interface DailyPoint {
  day: string;
  value: number;
}

export interface AgeSeries {
  /** Cumulative metric total at each whole day of age, index 0 = publish day. */
  cumulative: number[];
  /** Per-day metric value at each whole day of age. */
  daily: number[];
  total: number;
}

/**
 * Re-index a video's day-by-day series onto "days since publish".
 *
 * This is the derived view's whole point. Calendar dates make two episodes
 * released a month apart incomparable; age-in-days makes "day 7 of the new one
 * vs day 7 of the last five" a single subtraction. Days the API omitted are
 * filled with 0 rather than dropped, so index `n` always means "n days after
 * publish" — a gap that shifted later days left would quietly compare day 7
 * against day 9.
 *
 * Rows dated before `publishDate` are ignored: a video can accrue views on its
 * publish day but not before it, and a negative age has no slot on the axis.
 */
export function alignToAge(
  rows: DailyPoint[],
  publishDate: string,
  windowDays: number,
): AgeSeries {
  const daily = new Array<number>(windowDays).fill(0);
  for (const r of rows) {
    const age = daysBetween(publishDate, r.day);
    if (age < 0 || age >= windowDays) continue;
    daily[age] += r.value;
  }
  const cumulative: number[] = [];
  let running = 0;
  for (const v of daily) {
    running += v;
    cumulative.push(running);
  }
  return { cumulative, daily, total: running };
}
