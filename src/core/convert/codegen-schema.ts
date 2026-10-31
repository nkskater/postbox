import { z } from "zod";
import { CODEGEN_LANGUAGES } from "./codegen-targets";

export const codegenLanguageSchema = z.enum(CODEGEN_LANGUAGES.map((target) => target.id));
export const codegenOptionsSchema = z
  .record(z.string().max(80), z.union([z.string().max(80), z.number().finite(), z.boolean()]))
  .default({});
