export type Format = "json" | "table";
export interface Column {
  header: string;
  get(row: Record<string, unknown>): unknown;
}
export interface Page {
  limit?: number;
  offset: number;
}

/** JSON when piped, a table in a terminal; `--output` overrides. */
export function defaultFormat(isTty = Boolean(process.stdout.isTTY)): Format {
  return isTty ? "table" : "json";
}

export function paginate<T>(items: T[], { limit, offset }: Page) {
  const window = items.slice(offset, limit === undefined ? undefined : offset + limit);
  return { items: window, total: items.length, offset, limit: limit ?? null };
}

const cell = (value: unknown) =>
  value === undefined || value === null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value).replace(/\s+/g, " ");

export function renderTable(rows: Record<string, unknown>[], columns: Column[]): string {
  const cells = rows.map((row) => columns.map((column) => cell(column.get(row))));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((line) => line[index].length)),
  );
  const line = (values: string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [line(columns.map((column) => column.header)), ...cells.map(line)].join("\n");
}

export const column = (header: string, key: string): Column => ({
  header,
  get: (row) => row[key],
});

export function printList(
  format: Format,
  all: Record<string, unknown>[],
  columns: Column[],
  page: Page,
  write: (text: string) => void = (text) => process.stdout.write(text + "\n"),
  note: (text: string) => void = (text) => console.error(text),
) {
  const result = paginate(all, page);
  if (format === "json") return write(JSON.stringify(result, null, 2));
  write(result.items.length ? renderTable(result.items, columns) : "(none)");
  if (result.total > result.items.length)
    note(`Showing ${result.items.length} of ${result.total}; use --offset and --limit to page.`);
}

export function printItem(
  format: Format,
  value: unknown,
  write: (text: string) => void = (text) => process.stdout.write(text + "\n"),
) {
  if (format === "json" || typeof value !== "object" || value === null)
    return write(JSON.stringify(value, null, 2));
  const entries = Object.entries(value as Record<string, unknown>);
  const width = Math.max(...entries.map(([key]) => key.length));
  write(entries.map(([key, field]) => `${key.padEnd(width)}  ${cell(field).slice(0, 200)}`).join("\n"));
}
