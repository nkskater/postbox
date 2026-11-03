import { qualityFilter } from "@/server/scorecards";
export const filters = (req: Request) =>
  qualityFilter.parse(Object.fromEntries(new URL(req.url).searchParams));
export type Context = { params: Promise<{ id: string }> };
