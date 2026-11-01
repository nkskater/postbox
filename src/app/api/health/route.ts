import { NextResponse } from "next/server";
import { getSqlite } from "@/server/db";
import { withApiVersion } from "@/server/http";

export const dynamic = "force-dynamic";

/** Liveness/readiness probe used by Docker's HEALTHCHECK and the Windows local launcher. */
export function GET() {
  try {
    getSqlite().prepare("select 1").get();
    const instance = process.env.POSTBOX_INSTANCE_ID || undefined;
    return withApiVersion(
      NextResponse.json({
        status: "ok",
        app: "postbox",
        ...(instance ? { instance } : {}),
        time: new Date().toISOString(),
      }),
    );
  } catch (err) {
    return withApiVersion(
      NextResponse.json({ status: "error", error: (err as Error).message }, { status: 503 }),
    );
  }
}
