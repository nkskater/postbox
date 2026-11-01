import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSdkDefinition } from "@/core/sdk/source";
import { generateSdk } from "@/core/sdk/generate";
const run = promisify(execFile);
const exec: typeof run = (async (...args: Parameters<typeof run>) => {
  try {
    return await run(...args);
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    throw new Error(failed.message + "\n" + failed.stdout + "\n" + failed.stderr);
  }
}) as typeof run;
const spec = {
  openapi: "3.0.3",
  info: { title: "Pets", version: "1.0.0" },
  paths: {
    "/pets/{id}": {
      get: {
        operationId: "getPet",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        responses: {
          200: {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "integer" }, name: { type: "string" } },
      },
    },
  },
};
describe("SDK artifacts", () => {
  it("regenerates deterministic npm and wheel artifacts and compiles/imports their clients", async () => {
    const definition = readSdkDefinition(JSON.stringify(spec));
    const directory = await mkdtemp(path.join(os.tmpdir(), "postbox-sdk-"));
    try {
      for (const language of ["typescript", "python"] as const) {
        const artifact = generateSdk(definition, { language, name: "pet_client", version: "1.0.0" });
        expect(Buffer.from(artifact.archive)).toEqual(
          Buffer.from(generateSdk(definition, { language, name: "pet_client", version: "1.0.0" }).archive),
        );
        expect(artifact.sourceHash).toMatch(/^[a-f0-9]{64}$/);
        for (const [file, content] of Object.entries(artifact.files)) {
          const target = path.join(directory, language, file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content);
        }
        if (language === "typescript") {
          await exec(process.execPath, ["--check", path.join(directory, language, "client.js")]);
          await writeFile(
            path.join(directory, language, "use.ts"),
            'import {Client} from "./client.js"; const api = new Client({baseUrl:"https://example.test"}); const value = api.getpet({path:{id:1}}); value.then(pet => {const id:number=pet.id; console.log(id);});\n',
          );
          await writeFile(
            path.join(directory, language, "tsconfig.json"),
            JSON.stringify({
              compilerOptions: {
                strict: true,
                noEmit: true,
                skipLibCheck: true,
                module: "nodenext",
                moduleResolution: "nodenext",
                target: "es2022",
              },
              files: ["use.ts"],
            }),
          );
          await exec(process.execPath, [
            path.resolve("node_modules/typescript/bin/tsc"),
            "--project",
            path.join(directory, language, "tsconfig.json"),
          ]);
        } else {
          await exec("python3", ["-c", "import pet_client; print(pet_client.Client)"], {
            cwd: path.join(directory, language),
          });
          const wheel = path.join(directory, artifact.filename);
          await writeFile(wheel, artifact.archive);
          await exec("python3", [
            "-m",
            "pip",
            "install",
            "--no-index",
            "--no-deps",
            "--target",
            path.join(directory, "installed"),
            wheel,
          ]);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
