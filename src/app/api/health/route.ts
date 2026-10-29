import { NextResponse } from "next/server";
import { getSqlite } from "@/server/db";

export const dynamic = "force-dynamic";

/** Liveness/readiness probe used by Docker's HEALTHCHECK. */
export function GET() {
  try {
    getSqlite().prepare("select 1").get();
    return NextResponse.json({ status: "ok", time: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 503 });
  }
}
