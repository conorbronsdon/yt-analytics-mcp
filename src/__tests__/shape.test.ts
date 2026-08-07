import { describe, it, expect } from "vitest";
import {
  addDays,
  alignToAge,
  daysBetween,
  isoDate,
  round,
  stripNulls,
  toObjects,
} from "../shape.js";
import type { ReportResponse } from "../types.js";

/**
 * A verbatim response from the live API, captured 2026-08-07 against
 * `dimensions=video&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage`.
 * Not hand-written: the float noise in `averageViewPercentage` and the
 * positional-row layout are the two things `toObjects` exists to handle, and an
 * invented fixture would have neither.
 */
const LIVE_TOP_VIDEOS: ReportResponse = {
  kind: "youtubeAnalytics#resultTable",
  columnHeaders: [
    { name: "video", columnType: "DIMENSION", dataType: "STRING" },
    { name: "views", columnType: "METRIC", dataType: "INTEGER" },
    { name: "estimatedMinutesWatched", columnType: "METRIC", dataType: "INTEGER" },
    { name: "averageViewDuration", columnType: "METRIC", dataType: "INTEGER" },
    { name: "averageViewPercentage", columnType: "METRIC", dataType: "FLOAT" },
  ],
  rows: [
    ["9QQA4TZvEKU", 437, 36, 14, 26.74],
    ["PJ-3hXAUotI", 153, 750, 294, 9.3],
    ["4-OwCY3RGV0", 124, 10, 16, 36.02],
  ],
};

/** Live retention response, same capture. The float noise here is genuine. */
const LIVE_RETENTION: ReportResponse = {
  columnHeaders: [
    { name: "elapsedVideoTimeRatio", columnType: "DIMENSION", dataType: "FLOAT" },
    { name: "audienceWatchRatio", columnType: "METRIC", dataType: "FLOAT" },
    { name: "relativeRetentionPerformance", columnType: "METRIC", dataType: "FLOAT" },
  ],
  rows: [
    [0.01, 1.0678, 0.3751],
    [0.11, 0.73730000000000007, 0.2111],
    [0.12, 0.6525, 0.20855],
  ],
};

describe("toObjects", () => {
  it("names every column by its header, in order", () => {
    expect(toObjects(LIVE_TOP_VIDEOS)).toEqual([
      {
        video: "9QQA4TZvEKU",
        views: 437,
        estimatedMinutesWatched: 36,
        averageViewDuration: 14,
        averageViewPercentage: 26.74,
      },
      {
        video: "PJ-3hXAUotI",
        views: 153,
        estimatedMinutesWatched: 750,
        averageViewDuration: 294,
        averageViewPercentage: 9.3,
      },
      {
        video: "4-OwCY3RGV0",
        views: 124,
        estimatedMinutesWatched: 10,
        averageViewDuration: 16,
        averageViewPercentage: 36.02,
      },
    ]);
  });

  it("binds values by position — a reordered header list changes the mapping", () => {
    // The mutation leg. `rows` is positional and nothing in the payload ties a
    // number to its metric, so a test that only checked "views is a number"
    // would pass with every column mislabelled. Swap two headers and the output
    // must follow, or the zip is not really reading the headers.
    const swapped: ReportResponse = {
      ...LIVE_TOP_VIDEOS,
      columnHeaders: [
        { name: "video" },
        { name: "estimatedMinutesWatched" },
        { name: "views" },
        { name: "averageViewDuration" },
        { name: "averageViewPercentage" },
      ],
    };
    const first = toObjects(swapped)[0];
    expect(first.estimatedMinutesWatched).toBe(437);
    expect(first.views).toBe(36);
  });

  it("rounds float noise out of the retention curve but leaves integers alone", () => {
    expect(toObjects(LIVE_RETENTION)).toEqual([
      { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.0678, relativeRetentionPerformance: 0.3751 },
      { elapsedVideoTimeRatio: 0.11, audienceWatchRatio: 0.7373, relativeRetentionPerformance: 0.2111 },
      { elapsedVideoTimeRatio: 0.12, audienceWatchRatio: 0.6525, relativeRetentionPerformance: 0.2086 },
    ]);
    // 0.73730000000000007 must not survive; 437 must not become 437.0000.
    expect(toObjects(LIVE_RETENTION)[1].audienceWatchRatio).toBe(0.7373);
    expect(toObjects(LIVE_TOP_VIDEOS)[0].views).toBe(437);
  });

  it("returns an empty array for a report with no rows", () => {
    expect(toObjects({ columnHeaders: [{ name: "views" }] })).toEqual([]);
    expect(toObjects({})).toEqual([]);
  });
});

describe("date arithmetic", () => {
  it("counts whole days between two dates", () => {
    expect(daysBetween("2026-07-06", "2026-07-06")).toBe(0);
    expect(daysBetween("2026-07-06", "2026-07-13")).toBe(7);
    expect(daysBetween("2026-07-13", "2026-07-06")).toBe(-7);
  });

  it("crosses a US DST boundary without drifting", () => {
    // 2026-11-01 is the US fall-back. Parsed in local time on a US machine the
    // span below is 24.04 days, which floors to a different answer than it does
    // in July. UTC parsing is why this is exactly 31 either way.
    expect(daysBetween("2026-10-20", "2026-11-20")).toBe(31);
    expect(daysBetween("2026-03-01", "2026-04-01")).toBe(31);
  });

  it("crosses month and year boundaries", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2026-07-06", 27)).toBe("2026-08-02");
    expect(addDays("2026-07-06", 0)).toBe("2026-07-06");
  });

  it("takes the date half of an ISO timestamp", () => {
    expect(isoDate("2026-07-06T16:00:23Z")).toBe("2026-07-06");
  });
});

describe("alignToAge", () => {
  const rows = [
    { day: "2026-07-06", value: 398 },
    { day: "2026-07-07", value: 30 },
    { day: "2026-07-08", value: 4 },
    { day: "2026-07-09", value: 1 },
  ];

  it("indexes by days since publish, with index 0 as publish day", () => {
    expect(alignToAge(rows, "2026-07-06", 5)).toEqual({
      daily: [398, 30, 4, 1, 0],
      cumulative: [398, 428, 432, 433, 433],
      total: 433,
    });
  });

  it("fills a missing day with zero instead of shifting later days left", () => {
    // The bug this guards: dropping the gap would put 2026-07-09's value at
    // index 2, comparing day 3 of one video against day 2 of another.
    const gapped = [
      { day: "2026-07-06", value: 398 },
      // 07-07 absent
      { day: "2026-07-08", value: 4 },
    ];
    const out = alignToAge(gapped, "2026-07-06", 4);
    expect(out.daily).toEqual([398, 0, 4, 0]);
    expect(out.cumulative).toEqual([398, 398, 402, 402]);
  });

  it("shifts the whole curve when the publish date shifts", () => {
    // Mutation leg: same rows, different publish date. If the function ignored
    // publishDate and just used row order, this would be identical to the first
    // case. It must not be.
    const out = alignToAge(rows, "2026-07-04", 6);
    expect(out.daily).toEqual([0, 0, 398, 30, 4, 1]);
    expect(out.cumulative).toEqual([0, 0, 398, 428, 432, 433]);
  });

  it("drops rows outside the window on both ends", () => {
    const noisy = [
      { day: "2026-07-05", value: 999 }, // before publish
      { day: "2026-07-06", value: 398 },
      { day: "2026-07-20", value: 777 }, // past the window
    ];
    const out = alignToAge(noisy, "2026-07-06", 3);
    expect(out.daily).toEqual([398, 0, 0]);
    expect(out.total).toBe(398);
  });

  it("sums two rows that land on the same age", () => {
    const dupes = [
      { day: "2026-07-06", value: 10 },
      { day: "2026-07-06", value: 5 },
    ];
    expect(alignToAge(dupes, "2026-07-06", 2).daily).toEqual([15, 0]);
  });

  it("returns an empty series for a zero-length window", () => {
    expect(alignToAge(rows, "2026-07-06", 0)).toEqual({
      daily: [],
      cumulative: [],
      total: 0,
    });
  });
});

describe("stripNulls", () => {
  it("drops null, undefined and empty string but keeps zero and false", () => {
    expect(
      stripNulls({ a: 0, b: false, c: null, d: undefined, e: "", f: "x" }),
    ).toEqual({ a: 0, b: false, f: "x" });
  });

  it("recurses into nested objects and arrays", () => {
    expect(stripNulls({ rows: [{ views: 0, title: null }] })).toEqual({
      rows: [{ views: 0 }],
    });
  });
});

describe("round", () => {
  it("rounds to the requested places", () => {
    expect(round(0.73730000000000007, 4)).toBe(0.7373);
    expect(round(1 / 3, 4)).toBe(0.3333);
    expect(round(2.5, 0)).toBe(3);
  });
});
