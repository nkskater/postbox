import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { sendMonitorEmail, type MonitorSmtp } from "@/core/monitoring/email";
import { nextDelay } from "@/core/webhooks";
import { getDb, schema } from "./db";
import { getPolicy } from "./context";
const { monitorEmails } = schema;
export function smtpConfiguration(env: NodeJS.ProcessEnv = process.env): MonitorSmtp | null {
  const host = env.POSTBOX_SMTP_HOST?.trim(),
    from = env.POSTBOX_SMTP_FROM?.trim();
  if (!host || !from) return null;
  if (!z.email().safeParse(from).success || /[\r\n]/.test(host))
    throw new Error("Invalid SMTP configuration");
  const port = Number(env.POSTBOX_SMTP_PORT ?? (env.POSTBOX_SMTP_SECURE === "true" ? "465" : "587"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SMTP port");
  return {
    host,
    port,
    from,
    secure: env.POSTBOX_SMTP_SECURE === "true",
    requireTls: env.POSTBOX_SMTP_REQUIRE_TLS !== "false",
    user: env.POSTBOX_SMTP_USER,
    password: env.POSTBOX_SMTP_PASSWORD,
  };
}
const worker = ((
  globalThis as unknown as {
    __postboxMonitorMail?: {
      timer: ReturnType<typeof setInterval> | null;
      running: boolean;
      manual: boolean;
    };
  }
).__postboxMonitorMail ??= { timer: null, running: false, manual: false });
export function setMonitorEmailManual(manual: boolean) {
  worker.manual = manual;
  if (manual && worker.timer) {
    clearInterval(worker.timer);
    worker.timer = null;
  }
}
export function startMonitorEmailWorker() {
  if (worker.manual || worker.timer) return;
  worker.timer = setInterval(() => {
    void processMonitorEmails().catch(() => {});
  }, 1000);
  worker.timer.unref?.();
}
export async function processMonitorEmails(now = Date.now()) {
  if (worker.running) return 0;
  worker.running = true;
  let attempted = 0;
  try {
    const db = getDb();
    const entries = db.transaction(() => {
      const found = db
        .select()
        .from(monitorEmails)
        .where(
          and(
            eq(monitorEmails.status, "pending"),
            lte(monitorEmails.nextAttemptAt, now),
            or(isNull(monitorEmails.lockedUntil), lte(monitorEmails.lockedUntil, now)),
          ),
        )
        .orderBy(asc(monitorEmails.nextAttemptAt))
        .limit(4)
        .all();
      for (const item of found)
        db.update(monitorEmails)
          .set({ lockedUntil: now + 60000 })
          .where(eq(monitorEmails.id, item.id))
          .run();
      return found;
    });
    await Promise.all(
      entries.map(async (item) => {
        attempted++;
        let error: string | null = null,
          code = 0;
        try {
          const config = smtpConfiguration();
          if (!config) throw Object.assign(new Error("SMTP is not configured"), { permanent: true });
          await sendMonitorEmail(
            config,
            { id: item.id, to: item.recipient, subject: item.subject, text: item.body },
            getPolicy(),
          );
        } catch (e) {
          const failure = e as {
            responseCode?: number;
            permanent?: boolean;
            name?: string;
            message?: string;
          };
          code = failure.responseCode ?? 0;
          error = failure.permanent
            ? "SMTP is not configured"
            : failure.name === "HostPolicyError" || /PROXY_ALLOW|PROXY_DENY/.test(failure.message ?? "")
              ? "SMTP relay blocked by host policy"
              : "SMTP delivery failed";
          if (
            failure.permanent ||
            failure.name === "HostPolicyError" ||
            /PROXY_ALLOW|PROXY_DENY/.test(failure.message ?? "") ||
            code >= 500
          )
            code = 550;
        }
        const attempts = item.attempts + 1,
          delay = error && code < 500 ? nextDelay(attempts) : null;
        db.update(monitorEmails)
          .set({
            attempts,
            status: !error ? "delivered" : delay !== null ? "pending" : "failed",
            nextAttemptAt: delay !== null ? now + delay : null,
            lockedUntil: null,
            lastError: error,
            finishedAt: !error || delay === null ? now : null,
          })
          .where(eq(monitorEmails.id, item.id))
          .run();
      }),
    );
    return attempted;
  } finally {
    worker.running = false;
  }
}

export function monitorEmailIsBusy() {
  return worker.running;
}
export function stopMonitorEmailWorker() {
  if (worker.timer) clearInterval(worker.timer);
  worker.timer = null;
}
