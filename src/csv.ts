export interface RecordRow {
  student_name: string;
  student_id: string;
  created_at: number;
  flags: string;
}

function cell(v: string): string {
  // Neutralise spreadsheet formulas and quote every cell.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function formatTime(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export function toCsv(rows: RecordRow[], timeZone = "UTC"): string {
  const lines = [
    ["#", "Name", "Student ID", `Checked in (${timeZone})`, "Flags"].map(cell).join(","),
    ...rows.map((r, i) =>
      [String(i + 1), r.student_name, r.student_id, formatTime(r.created_at, timeZone), r.flags].map(cell).join(","),
    ),
  ];
  // BOM so Excel opens UTF-8 (e.g. Arabic names) correctly.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function fileName(sheetName: string): string {
  const slug = sheetName.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80);
  return `${slug || "attendance"}.csv`;
}
