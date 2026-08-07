import { saveTextFile } from "../api/backend";

/**
 * A small RFC4180-ish CSV parser for the "Import CSV" flow. Handles quoted
 * fields (with `""` as an escaped quote), a field's delimiter/newlines inside
 * quotes, and both `\n` and `\r\n` line endings. `delimiter` defaults to comma
 * but can be any single character — pass the same delimiter CSV export uses
 * so an exported file round-trips.
 */
export function parseCsv(text: string, delimiter = ","): string[][] {
  // Strip a leading BOM — `downloadCsv` writes one for Excel's benefit, and
  // left in place it would ride along on the first header name and stop that
  // column matching on re-import.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === delimiter) {
      endField();
      i++;
    } else if (c === "\r") {
      i++; // swallow; the following \n (if any) ends the row
    } else if (c === "\n") {
      endRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  // A trailing field/row not terminated by a final newline.
  if (field.length > 0 || row.length > 0) endRow();

  // Drop a single trailing blank row (e.g. the file ends with a newline).
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
  }
  return rows;
}

/**
 * Serialize rows (the first being the header) to CSV text. Shared by the
 * results grid's Export CSV and the AI panel's downloadable tables, so both
 * quote identically and a file exported from either round-trips back through
 * `parseCsv`.
 */
export function toCsv(rows: (string | null)[][], delimiter = ","): string {
  // Quote a field if it contains the active delimiter, a quote, or a newline —
  // the delimiter itself must be included since it isn't always a comma.
  const needsQuote = new RegExp(`["\\n\\r${delimiter === "\t" ? "\\t" : delimiter}]`);
  const escape = (v: string | null): string => {
    if (v === null) return "";
    if (needsQuote.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  return rows.map((row) => row.map(escape).join(delimiter)).join("\n") + "\n";
}

/**
 * Export rows to a `.csv` file the user picks in the native save dialog,
 * where they choose the folder and the name and confirm the write. Resolves
 * to the path saved, or `null` if they dismissed the dialog.
 *
 * The leading BOM is what makes the file open correctly in Excel: without it
 * Excel reads the bytes as the local ANSI codepage and mangles any non-ASCII
 * text. `parseCsv` strips it back off, so an exported file still re-imports
 * cleanly.
 */
export function saveCsv(
  rows: (string | null)[][],
  suggestedName: string,
  delimiter = ",",
): Promise<string | null> {
  const name = `${suggestedName.replace(/\.(sql|csv)$/, "") || "results"}.csv`;
  return saveTextFile(name, "﻿" + toCsv(rows, delimiter), [
    { name: "CSV", extensions: ["csv"] },
  ]);
}
