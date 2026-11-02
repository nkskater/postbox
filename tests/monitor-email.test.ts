import { describe, it, expect } from "vitest";
import { sendMonitorEmail } from "@/core/monitoring/email";
import { HostPolicy } from "@/core/http/policy";
import { startSmtpFixture } from "./helpers/smtp-server";
describe("monitor SMTP transport", () => {
  it("checks policy before sending, requires STARTTLS by default and sends stable plain-text message IDs", async () => {
    const smtp = await startSmtpFixture();
    const config = {
        host: "127.0.0.1",
        port: smtp.port,
        secure: false,
        requireTls: false,
        from: "monitor@example.test",
      },
      message = {
        id: "stable-notification",
        to: "alerts@example.test",
        subject: "Incident",
        text: "Numeric monitoring metrics only",
      };
    try {
      await expect(sendMonitorEmail(config, message, new HostPolicy([], ["127.0.0.0/8"]))).rejects.toThrow(
        "blocked",
      );
      expect(smtp.messages).toHaveLength(0);
      await expect(
        sendMonitorEmail({ ...config, requireTls: true }, message, new HostPolicy()),
      ).rejects.toThrow();
      expect(smtp.messages).toHaveLength(0);
      await sendMonitorEmail(config, message, new HostPolicy());
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]).toContain("<postbox-monitor-stable-notification@example.test>");
      expect(smtp.messages[0]).toContain("Numeric monitoring metrics only");
    } finally {
      await smtp.close();
    }
  });
});
