"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { RunOptions } from "@/core/types";
import { DEFAULT_RUN_OPTIONS } from "@/core/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Schedule {
  id: string;
  name: string;
  cron: string;
  environmentId: string | null;
  options: RunOptions;
  enabled: boolean;
  running: boolean;
  lastRunId: string | null;
  lastRunAt: number | null;
  lastRunStatus: string | null;
  nextRunAt: number | null;
}

interface Props {
  workspaceId: string;
  folderId: string;
  environments: { id: string; name: string }[];
  environmentId: string | null;
  onOpenRun: (id: string) => void;
  onRunStarted: () => void;
  canOpenRun: boolean;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.issues?.[0]?.message ?? body.error ?? "Could not update schedule");
  }
  return body as T;
}

export function Schedules({
  workspaceId,
  folderId,
  environments,
  environmentId,
  onOpenRun,
  onRunStarted,
  canOpenRun,
}: Props) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [envId, setEnvId] = useState<string | null>(environmentId);
  const [enabled, setEnabled] = useState(true);
  const [options, setOptions] = useState<RunOptions>({ ...DEFAULT_RUN_OPTIONS });
  const sequence = useRef(0);
  const refresh = useCallback(
    (signal?: AbortSignal) => {
      const current = ++sequence.current;
      return request<Schedule[]>(
        `/api/schedules?workspaceId=${encodeURIComponent(workspaceId)}&folderId=${encodeURIComponent(folderId)}`,
        { signal },
      )
        .then((rows) => {
          if (sequence.current === current) {
            setSchedules(rows);
            setError("");
          }
        })
        .catch((err: unknown) => {
          if (!signal?.aborted && sequence.current === current) setError((err as Error).message);
        });
    },
    [workspaceId, folderId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), 10000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [refresh]);

  const edit = (schedule?: Schedule) => {
    setEditing(schedule?.id ?? null);
    setName(schedule?.name ?? "Scheduled run");
    setCron(schedule?.cron ?? "0 9 * * 1-5");
    setEnvId(schedule ? schedule.environmentId : environmentId);
    setEnabled(schedule?.enabled ?? true);
    setOptions(schedule ? { ...schedule.options } : { ...DEFAULT_RUN_OPTIONS });
    setError("");
  };
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const patch = (id: string, body: unknown) =>
    request(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  return (
    <section className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Schedules</h3>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => edit()}>
          New schedule
        </Button>
      </div>
      <p className="text-muted-foreground">
        Cron times use UTC. The server must be running. Each schedule runs every request in this folder
        without iteration data; overlapping triggers are skipped.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!schedules.length && !error && <p className="text-muted-foreground">No schedules for this folder.</p>}
      {schedules.map((schedule) => (
        <div key={schedule.id} className="space-y-2 rounded-md border p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">{schedule.name}</span>
            <Switch
              aria-label={`Enable ${schedule.name}`}
              checked={schedule.enabled}
              disabled={busy}
              onCheckedChange={(value) => void mutate(() => patch(schedule.id, { enabled: value }))}
            />
          </div>
          <p>
            <code>{schedule.cron}</code> UTC ·{" "}
            {environments.find((env) => env.id === schedule.environmentId)?.name ?? "No environment"}
          </p>
          <p className="text-muted-foreground">
            {schedule.options.iterations} iteration(s) · {schedule.options.delayMs} ms delay
            {schedule.running ? " · Running" : ""}
          </p>
          {schedule.nextRunAt && (
            <p className="text-muted-foreground">Next: {new Date(schedule.nextRunAt).toLocaleString()}</p>
          )}
          {schedule.lastRunId && schedule.lastRunStatus ? (
            <button
              className="text-primary hover:underline disabled:cursor-default disabled:text-muted-foreground disabled:no-underline"
              disabled={schedule.running || !canOpenRun}
              onClick={() => onOpenRun(schedule.lastRunId!)}
            >
              Last run: {schedule.lastRunStatus}
              {schedule.lastRunAt ? ` · ${new Date(schedule.lastRunAt).toLocaleString()}` : ""}
            </button>
          ) : (
            <p className="text-muted-foreground">No retained run history.</p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || schedule.running}
              onClick={() =>
                void mutate(async () => {
                  await request(`/api/schedules/${schedule.id}/run`, { method: "POST" });
                  onRunStarted();
                })
              }
            >
              Run now
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(schedule)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void mutate(async () => {
                  await request(`/api/schedules/${schedule.id}`, { method: "DELETE" });
                  if (editing === schedule.id) setEditing(undefined);
                })
              }
            >
              Delete
            </Button>
          </div>
        </div>
      ))}
      {editing !== undefined && (
        <form
          className="space-y-3 rounded-md border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              const body = {
                name,
                cron,
                environmentId: envId,
                enabled,
                options: { ...options, timeoutMs: options.timeoutMs ?? null },
              };
              if (editing) await patch(editing, body);
              else
                await request("/api/schedules", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ ...body, workspaceId, folderId }),
                });
              setEditing(undefined);
            });
          }}
        >
          <h4 className="font-medium">{editing ? "Edit schedule" : "New schedule"}</h4>
          <label className="block space-y-1">
            Name
            <Input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block space-y-1">
            Cron (UTC)
            <Input
              required
              maxLength={200}
              placeholder="0 9 * * 1-5"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
            />
          </label>
          <p className="text-muted-foreground">
            Example: <code>0 9 * * 1-5</code> runs at 09:00 UTC on weekdays. A leading seconds field is
            optional.
          </p>
          <div className="space-y-1">
            <span>Environment</span>
            <Select
              value={envId ?? "__none"}
              onValueChange={(value) => setEnvId(value === "__none" ? null : value)}
            >
              <SelectTrigger aria-label="Schedule environment" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">No environment</SelectItem>
                {environments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    {env.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label>
              Iterations
              <Input
                type="number"
                min={1}
                max={100000}
                required
                value={options.iterations}
                onChange={(e) => setOptions({ ...options, iterations: Number(e.target.value) })}
              />
            </label>
            <label>
              Delay (ms)
              <Input
                type="number"
                min={0}
                max={600000}
                required
                value={options.delayMs}
                onChange={(e) => setOptions({ ...options, delayMs: Number(e.target.value) })}
              />
            </label>
            <label className="col-span-2">
              Timeout (ms, blank uses request settings)
              <Input
                type="number"
                min={100}
                max={2147483647}
                value={options.timeoutMs ?? ""}
                onChange={(e) =>
                  setOptions({ ...options, timeoutMs: e.target.value ? Number(e.target.value) : undefined })
                }
              />
            </label>
          </div>
          <label className="flex items-center gap-2">
            <Switch
              checked={options.stopOnFailure}
              onCheckedChange={(value) => setOptions({ ...options, stopOnFailure: value })}
            />
            Stop on first failure
          </label>
          <label className="flex items-center gap-2">
            <Switch
              checked={options.verifySsl !== false}
              onCheckedChange={(value) => setOptions({ ...options, verifySsl: value })}
            />
            Verify SSL certificates
          </label>
          <label className="flex items-center gap-2">
            <Switch
              checked={options.persistVariables !== false}
              onCheckedChange={(value) => setOptions({ ...options, persistVariables: value })}
            />
            Persist variable changes
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            Enabled
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              Save schedule
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(undefined)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
