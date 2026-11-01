"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sdkOptionsSchema } from "@/core/sdk/model";
export function SdkDownload({
  entryId,
  version,
  label,
}: {
  entryId: string;
  version: number;
  label: string;
}) {
  const [language, setLanguage] = useState<"typescript" | "python">("typescript"),
    [name, setName] = useState("postbox_client"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const download = async () => {
    const options = sdkOptionsSchema.safeParse({ language, name, version: label });
    if (!options.success) {
      setError("Choose a valid package identifier and supported language.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/catalog/${entryId}?${new URLSearchParams({ format: "sdk", language, name, version: String(version) })}`,
      );
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? "SDK generation failed");
      }
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download =
        response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "sdk-artifact";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Download failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-3 space-y-2 rounded border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <label>
          SDK language{" "}
          <select
            aria-label="SDK language"
            value={language}
            onChange={(e) => setLanguage(e.target.value as typeof language)}
            className="ml-1 rounded border bg-background p-2"
          >
            <option value="typescript">TypeScript / npm</option>
            <option value="python">Python / wheel</option>
          </select>
        </label>
        <Input
          className="max-w-52"
          aria-label="SDK package name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button size="sm" variant="outline" onClick={() => void download()} disabled={busy}>
          Download SDK {label}
        </Button>
      </div>
      <p className="text-muted-foreground">
        Generated from this immutable version. Configure credentials and request values at runtime. Catalog
        entries without schemas use typed JSON values; use an OpenAPI/contract definition through the CLI for
        structural models.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
