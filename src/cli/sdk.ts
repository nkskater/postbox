import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { generateSdk } from "../core/sdk/generate";
import { readSdkDefinition } from "../core/sdk/source";
import { sdkOptionsSchema, SDK_LIMITS } from "../core/sdk/model";
import { CliError, EXIT } from "./errors";
export function registerSdk(program: Command) {
  const group = program
    .command("sdk")
    .description(
      "Generate installable typed HTTP clients from local versioned collection/OpenAPI definitions.",
    )
    .exitOverride();
  group
    .command("generate")
    .description(
      "Generate a deterministic npm .tgz or Python wheel without network access or overwriting files.",
    )
    .argument("<definition>", "Postman collection or OpenAPI JSON/YAML file")
    .requiredOption("--language <language>", "typescript or python")
    .requiredOption("--sdk-version <version>", "Immutable SDK version, e.g. 1.0.0")
    .option("--name <name>", "Package identifier (lowercase letters/digits/underscores)", "postbox_client")
    .requiredOption(
      "--out-dir <directory>",
      "Artifact directory; generated filenames are preserved and existing files are never overwritten",
    )
    .option("--json", "Print artifact manifest as JSON")
    .exitOverride()
    .action(
      async (
        file: string,
        options: { language: string; sdkVersion: string; name: string; outDir: string; json?: boolean },
        command: Command,
      ) => {
        const parsed = sdkOptionsSchema.safeParse({ ...options, version: options.sdkVersion });
        if (!parsed.success) throw new CliError(parsed.error.message, EXIT.invalid);
        let text: string;
        try {
          const info = await stat(file);
          if (info.size > SDK_LIMITS.sourceBytes)
            throw new CliError("SDK definition exceeds 2 MiB", EXIT.invalid);
          text = await readFile(file, "utf8");
        } catch (error) {
          if (error instanceof CliError) throw error;
          throw new CliError(
            error instanceof Error ? error.message : "Cannot read SDK definition",
            EXIT.notFound,
          );
        }
        let artifact;
        try {
          artifact = generateSdk(readSdkDefinition(text), parsed.data);
        } catch (error) {
          throw new CliError(error instanceof Error ? error.message : "Invalid SDK definition", EXIT.invalid);
        }
        await mkdir(options.outDir, { recursive: true });
        const destination = join(options.outDir, artifact.filename);
        try {
          await writeFile(destination, artifact.archive, { flag: "wx" });
        } catch (error) {
          throw new CliError(error instanceof Error ? error.message : "Cannot write artifact", EXIT.invalid);
        }
        const result = {
          output: destination,
          filename: artifact.filename,
          sha256: artifact.sha256,
          sourceHash: artifact.sourceHash,
          operations: artifact.operations,
        };
        if (options.json || command.optsWithGlobals().json) console.log(JSON.stringify(result));
        else console.log(`Wrote ${destination}\nSHA-256 ${artifact.sha256}`);
      },
    );
}
