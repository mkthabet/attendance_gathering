import { describe, expect, it } from "vitest";
import { WINDOW_MS, qrToken, verifyQrToken } from "../src/crypto";
import { fileName, toCsv } from "../src/csv";

describe("rotating QR token", () => {
  const secret = "test-secret", sheet = "abc123";
  const now = 1_790_000_000_000;
  const win = Math.floor(now / WINDOW_MS);

  it("accepts the current and previous window", async () => {
    expect(await verifyQrToken(secret, sheet, win.toString(36), await qrToken(secret, sheet, win), now)).toBe(true);
    expect(await verifyQrToken(secret, sheet, (win - 1).toString(36), await qrToken(secret, sheet, win - 1), now)).toBe(true);
  });

  it("rejects older or future windows", async () => {
    expect(await verifyQrToken(secret, sheet, (win - 2).toString(36), await qrToken(secret, sheet, win - 2), now)).toBe(false);
    expect(await verifyQrToken(secret, sheet, (win + 1).toString(36), await qrToken(secret, sheet, win + 1), now)).toBe(false);
  });

  it("rejects a token for another sheet or secret", async () => {
    expect(await verifyQrToken(secret, sheet, win.toString(36), await qrToken(secret, "other", win), now)).toBe(false);
    expect(await verifyQrToken(secret, sheet, win.toString(36), await qrToken("nope", sheet, win), now)).toBe(false);
  });
});

describe("csv export", () => {
  it("quotes cells, neutralises formulas and adds a BOM", () => {
    const csv = toCsv([{ student_name: '=HYPERLINK("x")', student_id: "42", created_at: 0, flags: "" }]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it("builds a readable file name", () => {
    expect(fileName("CS101 / Week 3")).toBe("CS101-Week-3.csv");
    expect(fileName("محاضرة 1")).toBe("محاضرة-1.csv");
  });
});
