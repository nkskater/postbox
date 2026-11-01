/** Write docs/openapi/postbox-management-v1.json. Run with `npm run openapi:generate`. */
import fs from "node:fs";
import path from "node:path";
import { buildOpenApi } from "../src/core/management-api/openapi";

export const OPENAPI_FILE = path.join(process.cwd(), "docs", "openapi", "postbox-management-v1.json");
fs.mkdirSync(path.dirname(OPENAPI_FILE), { recursive: true });
fs.writeFileSync(OPENAPI_FILE, JSON.stringify(buildOpenApi(), null, 2) + "\n");
console.log(`wrote ${path.relative(process.cwd(), OPENAPI_FILE)}`);
