import dns from "node:dns";
import net from "node:net";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { HostPolicy } from "../http/policy";
import { HostPolicyError } from "../http/policy";
import { tlsOptions } from "../http/outbound";
export interface MonitorSmtp {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  from: string;
  user?: string;
  password?: string;
}
/** The administrator supplies the relay; all direct addresses still pass the outbound policy. */
export async function sendMonitorEmail(
  config: MonitorSmtp,
  message: { id: string; to: string; subject: string; text: string },
  policy: HostPolicy,
) {
  policy.assertDirect(config.host, config.port, "SMTP");
  const lookup: net.LookupFunction = (host, options, callback) =>
    dns.lookup(host, options, (error, address, family) => {
      if (error) return callback(error, address as string, family);
      for (const item of Array.isArray(address) ? address : [{ address, family }]) {
        const reason = policy.check(host, item.address);
        if (reason) return callback(new HostPolicyError(reason), "", 4);
      }
      callback(null, address as string, family);
    });
  const options: SMTPTransport.Options = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTls,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    tls: {
      ...tlsOptions(policy.network?.tlsFor(config.host, config.port)),
      servername: net.isIP(config.host) ? undefined : config.host,
      rejectUnauthorized: true,
    },
    ...(config.user ? { auth: { user: config.user, pass: config.password ?? "" } } : {}),
    getSocket: (_options, callback) => {
      const socket = net.connect({ host: config.host, port: config.port, lookup });
      const timer = setTimeout(() => socket.destroy(new Error("SMTP connection timed out")), 10000);
      const failed = (error: Error) => {
        clearTimeout(timer);
        callback(error, undefined);
      };
      socket.once("error", failed);
      socket.once("connect", () => {
        socket.off("error", failed);
        clearTimeout(timer);
        callback(null, { connection: socket });
      });
    },
  };
  const transport = nodemailer.createTransport(options);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        messageId: `<postbox-monitor-${message.id}@${config.from.split("@")[1]}>`,
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          transport.close();
          reject(new Error("SMTP delivery deadline exceeded"));
        }, 30000);
        deadline.unref?.();
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
    transport.close();
  }
}
