import {annotateValue, fileUrl, renderEach} from "./embed-dom.ts";

const maximumTableBytes = 1_048_576;
const maximumTableCells = 20_000;
const maximumTableColumns = 256;
const cellLimit = `A table has at most ${maximumTableCells} cells.`;
// Anchored, and no two quantifiers can match the same characters, so matching is linear.
const numericPattern = /^[-+]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)%?$/u;

void renderEach("table", async (element, path) => {
  const response = await fetch(fileUrl(path)).catch(() => null);
  if (response?.ok !== true) throw new Error(`${path} could not be loaded.`);
  const tooLarge = `${path} is larger than the 1 MiB a table may hold.`;
  if (Number(response.headers.get("content-length")) > maximumTableBytes) throw new Error(tooLarge);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maximumTableBytes) throw new Error(tooLarge);
  const rows = parseCsv(new TextDecoder().decode(bytes));
  const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (rows.length * columns > maximumTableCells) throw new Error(cellLimit);
  element.replaceChildren(csvTable(path, rows, columns, element.getAttribute("title") ?? path));
});

/**
 * RFC 4180 records: quoted fields, doubled quotes, CRLF or LF, newlines inside quotes.
 * One pass over the text; a broken limit or an unclosed quote throws a readable error.
 */
function parseCsv(text: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cells = 0;
  let index = 0;
  for (;;) {
    let field = "";
    if (text[index] === "\"") {
      let start = index + 1;
      for (;;) {
        const quote = text.indexOf("\"", start);
        if (quote === -1) throw new Error("A quoted field of this table is never closed.");
        field += text.slice(start, quote);
        if (text[quote + 1] !== "\"") {
          index = quote + 1;
          break;
        }
        field += "\"";
        start = quote + 2;
      }
    } else {
      const start = index;
      while (index < text.length && text[index] !== "," && text[index] !== "\n" && text[index] !== "\r") index += 1;
      field = text.slice(start, index);
    }
    row.push(field);
    cells += 1;
    if (row.length > maximumTableColumns) throw new Error(`A table has at most ${maximumTableColumns} columns.`);
    if (cells > maximumTableCells) throw new Error(cellLimit);
    const separator = text[index];
    if (separator === ",") {
      index += 1;
      continue;
    }
    if (separator !== undefined && separator !== "\n" && separator !== "\r") {
      throw new Error("A quoted field of this table is followed by text before its separator.");
    }
    rows.push(row);
    row = [];
    index += separator === "\r" && text[index + 1] === "\n" ? 2 : 1;
    if (index >= text.length) return rows;
  }
}

/** The first record is the header row, short rows are padded to `columns`; every cell carries its A1 reference. */
function csvTable(path: string, rows: readonly (readonly string[])[], columns: number, label: string): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "as-embed-table";
  table.setAttribute("aria-label", label);
  const letters = Array.from({length: columns}, (unused, index) => columnName(index));
  const head = table.createTHead();
  head.insertRow().append(headerCell("", "col"), ...letters.map((letter) => headerCell(letter, "col")));
  const body = table.createTBody();
  rows.forEach((row, rowIndex) => {
    const tableRow = (rowIndex === 0 ? head : body).insertRow();
    tableRow.append(headerCell(String(rowIndex + 1), "row"));
    letters.forEach((letter, columnIndex) => {
      const text = row[columnIndex] ?? "";
      const cell = rowIndex === 0 ? headerCell(text, "col") : document.createElement("td");
      const reference = `${letter}${rowIndex + 1}`;
      cell.textContent = text;
      if (rowIndex > 0 && numericPattern.test(text)) cell.className = "as-embed-number";
      cell.setAttribute("data-cell", reference);
      cell.setAttribute("data-annotate", annotateValue(path, reference));
      tableRow.append(cell);
    });
  });
  return table;
}

function headerCell(text: string, scope: "col" | "row"): HTMLTableCellElement {
  const cell = document.createElement("th");
  cell.scope = scope;
  cell.textContent = text;
  return cell;
}

function columnName(index: number): string {
  let name = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}
