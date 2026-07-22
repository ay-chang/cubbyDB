/**
 * A small RFC4180-ish CSV parser for the "Import CSV" flow. Handles quoted
 * fields (with `""` as an escaped quote), a field's delimiter/newlines inside
 * quotes, and both `\n` and `\r\n` line endings. `delimiter` defaults to comma
 * but can be any single character — pass the same delimiter CSV export uses
 * so an exported file round-trips.
 */
export function parseCsv(text: string, delimiter = ","): string[][] {
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
