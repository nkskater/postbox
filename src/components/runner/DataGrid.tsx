"use client";
/**
 * Editable grid for iteration data: edit cells, rename/delete columns, delete
 * rows, trim whitespace, dedupe, drop empty rows and filter before running.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Columns3, Download, Eraser, Filter, Plus, Rows3, Scissors, Trash2, X } from "lucide-react";
import type { DataTable } from "@/core/types";
import {
  dedupeRows,
  deleteColumn,
  dropEmptyRows,
  filterRows,
  renameColumn,
  toCsv,
  trimWhitespace,
} from "@/core/runner/data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PAGE = 100;

export function DataGrid({
  table,
  onChange,
  filter,
  onFilterChange,
}: {
  table: DataTable;
  onChange: (t: DataTable | null) => void;
  filter: string;
  onFilterChange: (f: string) => void;
}) {
  const [page, setPage] = useState(0);
  const [editingCol, setEditingCol] = useState<string | null>(null);

  // Keep original row indexes so edits on a filtered view hit the right row.
  const view = useMemo(() => {
    const indexed = table.rows.map((r, i) => ({ ...r, __i: String(i) }));
    const f = filterRows({ columns: table.columns, rows: indexed }, filter);
    return f.rows.map((r) => Number(r.__i));
  }, [table, filter]);
  const pages = Math.max(1, Math.ceil(view.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = view.slice(current * PAGE, current * PAGE + PAGE);

  const setCell = (row: number, col: string, value: string) =>
    onChange({ ...table, rows: table.rows.map((r, i) => (i === row ? { ...r, [col]: value } : r)) });

  const download = () => {
    const blob = new Blob([toCsv(table)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "iteration-data.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex min-h-0 flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            try {
              onChange(trimWhitespace(table));
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
          title="Trim whitespace in headers and cells"
        >
          <Scissors className="size-3.5" /> Trim
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onChange(dedupeRows(table))}
          title="Remove duplicate rows"
        >
          <Rows3 className="size-3.5" /> Dedupe
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onChange(dropEmptyRows(table))}
          title="Remove rows where every cell is empty"
        >
          <Eraser className="size-3.5" /> Drop empty
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() =>
            onChange({
              ...table,
              rows: [...table.rows, Object.fromEntries(table.columns.map((c) => [c, ""]))],
            })
          }
        >
          <Plus className="size-3.5" /> Row
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            let name = "column";
            for (let n = 1; table.columns.includes(name); n++) name = `column${n}`;
            onChange({
              columns: [...table.columns, name],
              rows: table.rows.map((r) => ({ ...r, [name]: "" })),
            });
            setEditingCol(name);
          }}
        >
          <Columns3 className="size-3.5" /> Column
        </Button>
        <Button variant="ghost" size="icon" className="size-7" title="Download CSV" onClick={download}>
          <Download className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Remove data"
          onClick={() => onChange(null)}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Filter className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => {
              onFilterChange(e.target.value);
              setPage(0);
            }}
            placeholder="Filter rows: text, column=value, column!=value, column~=part"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <span className="shrink-0 text-muted-foreground">
          {view.length === table.rows.length
            ? `${table.rows.length} rows`
            : `${view.length} of ${table.rows.length} rows`}
        </span>
      </div>
      <div className="min-h-0 overflow-auto rounded-md border">
        <table className="w-max min-w-full border-collapse font-mono">
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <th className="w-10 border-b border-r px-2 py-1 text-right font-normal text-muted-foreground">
                #
              </th>
              {table.columns.map((c) => (
                <th key={c} className="group min-w-32 border-b border-r px-1 py-1 text-left font-medium">
                  {editingCol === c ? (
                    <input
                      autoFocus
                      defaultValue={c}
                      className="w-full rounded border border-primary bg-background px-1 outline-none"
                      onBlur={(e) => {
                        onChange(renameColumn(table, c, e.target.value.trim()));
                        setEditingCol(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  ) : (
                    <div className="flex items-center gap-1">
                      <span
                        className="cursor-text truncate"
                        title={`Double-click to rename · available as {{${c}}}`}
                        onDoubleClick={() => setEditingCol(c)}
                      >
                        {c}
                      </span>
                      <span className="text-[10px] font-normal text-success opacity-0 group-hover:opacity-100">{`{{${c}}}`}</span>
                      <button
                        className="ml-auto rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                        title="Delete column"
                        onClick={() => onChange(deleteColumn(table, c))}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  )}
                </th>
              ))}
              <th className="w-8 border-b" />
            </tr>
          </thead>
          <tbody>
            {shown.map((rowIndex) => (
              <tr key={rowIndex} className="group/row hover:bg-accent/40">
                <td className="border-r border-b px-2 text-right text-muted-foreground">{rowIndex + 1}</td>
                {table.columns.map((c) => (
                  <td key={c} className="border-r border-b p-0">
                    <input
                      className="h-6 w-full bg-transparent px-1.5 outline-none focus:bg-accent"
                      value={table.rows[rowIndex][c] ?? ""}
                      onChange={(e) => setCell(rowIndex, c, e.target.value)}
                    />
                  </td>
                ))}
                <td className="border-b px-1">
                  <button
                    className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover/row:opacity-100"
                    title="Delete row"
                    onClick={() => onChange({ ...table, rows: table.rows.filter((_, i) => i !== rowIndex) })}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            Prev
          </Button>
          <span className="text-muted-foreground">
            Page {current + 1} / {pages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
