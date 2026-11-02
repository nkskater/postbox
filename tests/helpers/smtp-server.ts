import net from "node:net";
import type { AddressInfo } from "node:net";
export async function startSmtpFixture(port = 0) {
  const messages: string[] = [],
    sockets = new Set<net.Socket>();
  let failNext = 0,
    failCode = 451;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("220 fixture SMTP\r\n");
    let pending = "",
      data = false,
      message = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      for (;;) {
        const pos = pending.indexOf("\r\n");
        if (pos < 0) return;
        const line = pending.slice(0, pos);
        pending = pending.slice(pos + 2);
        if (data) {
          if (line === ".") {
            messages.push(message);
            data = false;
            message = "";
            socket.write(failNext-- > 0 ? `${failCode} try later\r\n` : "250 queued\r\n");
          } else message += line + "\r\n";
        } else if (/^EHLO|^HELO/i.test(line)) socket.write("250 fixture\r\n");
        else if (/^MAIL FROM|^RCPT TO|^RSET/i.test(line)) socket.write("250 ok\r\n");
        else if (/^DATA/i.test(line)) {
          data = true;
          socket.write("354 end with dot\r\n");
        } else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    fail: (count: number, code = 451) => {
      failCode = code;
      failNext = count;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
