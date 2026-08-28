/**
 * The date/time reader.
 *
 * These are the phrasings players actually type. The parser is allowed to be wrong
 * about nothing here: a misread hour turns "is 7pm free" into an answer about a
 * different slot, and the player only finds out at the venue.
 */

import { describe, expect, it } from "vitest";
import { dateLabel, describeWhen, parseWhen } from "@/lib/assistant/when";

/* Thursday. Saturday is the 29th, next Saturday the 5th. */
const TODAY = "2026-08-27";

describe("days", () => {
  it("defaults to today and says so", () => {
    const w = parseWhen("is anything free", TODAY);
    expect(w.dateISO).toBe(TODAY);
    expect(w.assumedToday).toBe(true);
    expect(w.precision).toBe("day");
  });

  it("reads today, tomorrow and the day after", () => {
    expect(parseWhen("free today", TODAY).dateISO).toBe("2026-08-27");
    expect(parseWhen("free tomorrow", TODAY).dateISO).toBe("2026-08-28");
    expect(parseWhen("tmr any court", TODAY).dateISO).toBe("2026-08-28");
    expect(parseWhen("bukas may bakante", TODAY).dateISO).toBe("2026-08-28");
    expect(parseWhen("day after tomorrow", TODAY).dateISO).toBe("2026-08-29");
  });

  it("reads a weekday as the coming one", () => {
    expect(parseWhen("open on saturday", TODAY).dateISO).toBe("2026-08-29");
    expect(parseWhen("sat 9am", TODAY).dateISO).toBe("2026-08-29");
    /* Today is Thursday, so "thursday" is today rather than a week out. */
    expect(parseWhen("thursday", TODAY).dateISO).toBe("2026-08-27");
  });

  it("only jumps a week for 'next' when the day is already today", () => {
    expect(parseWhen("next saturday", TODAY).dateISO).toBe("2026-08-29");
    expect(parseWhen("next thursday", TODAY).dateISO).toBe("2026-09-03");
  });

  it("reads written and numeric dates", () => {
    expect(parseWhen("aug 30", TODAY).dateISO).toBe("2026-08-30");
    expect(parseWhen("30 august", TODAY).dateISO).toBe("2026-08-30");
    expect(parseWhen("september 5 2026", TODAY).dateISO).toBe("2026-09-05");
    expect(parseWhen("2026-09-05", TODAY).dateISO).toBe("2026-09-05");
    expect(parseWhen("9/5", TODAY).dateISO).toBe("2026-09-05");
    /* 30 cannot be a month, so it is the day. */
    expect(parseWhen("30/9", TODAY).dateISO).toBe("2026-09-30");
  });

  it("does not read a date's day number as a time", () => {
    const w = parseWhen("is court 1 free on aug 30", TODAY);
    expect(w.dateISO).toBe("2026-08-30");
    expect(w.precision).toBe("day");
  });
});

describe("times", () => {
  it("reads an explicit hour with a meridiem", () => {
    expect(parseWhen("free at 7pm", TODAY).hours).toEqual([19]);
    expect(parseWhen("free at 7am", TODAY).hours).toEqual([7]);
    expect(parseWhen("9:30 am", TODAY).hours).toEqual([9]);
    expect(parseWhen("12am", TODAY).hours).toEqual([0]);
    expect(parseWhen("12pm", TODAY).hours).toEqual([12]);
  });

  it("reads a range as the slots inside it, not the end instant", () => {
    expect(parseWhen("7-9pm", TODAY).hours).toEqual([19, 20]);
    expect(parseWhen("from 7pm to 9pm", TODAY).hours).toEqual([19, 20]);
    expect(parseWhen("9am to 12pm", TODAY).hours).toEqual([9, 10, 11]);
    expect(parseWhen("book 6 to 8 pm", TODAY).hours).toEqual([18, 19]);
  });

  it("carries the end meridiem back to a bare start", () => {
    expect(parseWhen("8-10pm", TODAY).hours).toEqual([20, 21]);
  });

  it("takes a bare evening-shaped hour as PM and records the assumption", () => {
    const w = parseWhen("is it free at 7", TODAY);
    expect(w.hours).toEqual([19]);
    expect(w.assumedPm).toBe(true);
  });

  it("reads a 24-hour clock without assuming", () => {
    const w = parseWhen("at 19:00", TODAY);
    expect(w.hours).toEqual([19]);
    expect(w.assumedPm).toBe(false);
  });

  it("reads parts of the day as bands", () => {
    expect(parseWhen("free tomorrow morning", TODAY).hours).toEqual([6, 7, 8, 9, 10, 11]);
    /* "this evening" is quoted back to the player as 5:00-10:00 PM, so the band is
       the hours that phrase covers. */
    expect(parseWhen("anything tonight", TODAY).hours).toEqual([17, 18, 19, 20, 21]);
    expect(parseWhen("saturday afternoon", TODAY).precision).toBe("band");
  });

  it("lets tonight set the day as well as the band", () => {
    const w = parseWhen("any court tonight", TODAY);
    expect(w.dateISO).toBe(TODAY);
    expect(w.assumedToday).toBe(false);
  });
});

describe("labels", () => {
  it("names the day the way a person would", () => {
    expect(dateLabel("2026-08-27", TODAY)).toBe("today");
    expect(dateLabel("2026-08-28", TODAY)).toBe("tomorrow");
    expect(dateLabel("2026-08-29", TODAY)).toBe("Sat, 29 Aug");
  });

  it("shows the resolved slot so a misreading is visible", () => {
    expect(describeWhen(parseWhen("tomorrow 7-9pm", TODAY), TODAY)).toBe(
      "tomorrow 7:00 PM – 9:00 PM",
    );
    expect(describeWhen(parseWhen("sat at 9am", TODAY), TODAY)).toBe("Sat, 29 Aug 9:00 AM");
  });
});
