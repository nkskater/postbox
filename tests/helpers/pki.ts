/** Throwaway CA, server and client certificates generated with the openssl CLI. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Pki {
  caCert: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
  /** The same client key, encrypted with `passphrase`. */
  encryptedClientKey: string;
  passphrase: string;
  /** A certificate from a different CA, for mismatch tests. */
  otherCaCert: string;
  otherClientCert: string;
  otherClientKey: string;
}

function openssl(cwd: string, ...args: string[]) {
  execFileSync("openssl", args, { cwd, stdio: "pipe" });
}

export function createPki(): Pki {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postbox-pki-"));
  const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
  const authority = (name: string) => {
    openssl(
      dir,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.crt`,
      "-days",
      "2",
      "-subj",
      `/CN=${name}`,
    );
  };
  const leaf = (name: string, ca: string, subject: string, ext: string) => {
    openssl(
      dir,
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      subject,
    );
    fs.writeFileSync(path.join(dir, `${name}.ext`), ext);
    openssl(
      dir,
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      `${ca}.crt`,
      "-CAkey",
      `${ca}.key`,
      "-CAcreateserial",
      "-out",
      `${name}.crt`,
      "-days",
      "2",
      "-extfile",
      `${name}.ext`,
    );
  };
  authority("ca");
  authority("other-ca");
  leaf(
    "server",
    "ca",
    "/CN=localhost",
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth",
  );
  leaf("client", "ca", "/CN=postbox-client", "extendedKeyUsage=clientAuth");
  leaf("other-client", "other-ca", "/CN=intruder", "extendedKeyUsage=clientAuth");
  openssl(
    dir,
    "pkey",
    "-in",
    "client.key",
    "-aes256",
    "-passout",
    "pass:s3cret-phrase",
    "-out",
    "client-enc.key",
  );
  const pki: Pki = {
    caCert: read("ca.crt"),
    serverCert: read("server.crt"),
    serverKey: read("server.key"),
    clientCert: read("client.crt"),
    clientKey: read("client.key"),
    encryptedClientKey: read("client-enc.key"),
    passphrase: "s3cret-phrase",
    otherCaCert: read("other-ca.crt"),
    otherClientCert: read("other-client.crt"),
    otherClientKey: read("other-client.key"),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return pki;
}
