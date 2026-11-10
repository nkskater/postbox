import { it, expect, inject } from "vitest";
import { launch } from "./helpers";
import { fakeOidc } from "../tests/helpers/sso-idp";
it("configures SSO, signs in with a verified identity, logs out, and recovers with a local password", async () => {
  const browser = await launch(),
    idp = await fakeOidc(),
    base = inject("ssoUrl");
  const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page = await context.newPage(),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    // A local administrator remains the recovery route after SSO has been enabled.
    const setup = await context.request.post(`${base}/api/auth/setup`, {
      headers: { Authorization: "Bearer e2e-sso-admin-token" },
      data: { username: "recovery-admin", password: "recovery-password" },
    });
    expect(setup.ok()).toBe(true);
    await page.goto(`${base}/profile`);
    await page.getByRole("link", { name: "Manage single sign-on" }).click();
    await page.getByRole("heading", { name: "Single sign-on", exact: true }).waitFor();
    await page.getByLabel("Sign-in button name").fill("Fixture identity");
    await page.getByLabel("Public Postbox origin").fill(base);
    await page.getByLabel("Issuer URL").fill(idp.issuer);
    await page.getByLabel("Client ID", { exact: true }).fill("browser-client");
    await page.getByLabel("Client authentication").selectOption("none");
    await page.getByLabel("Create an account for new verified subjects").check();
    await page.getByLabel("Enable sign-in", { exact: true }).check();
    await page.getByRole("button", { name: "Save provider", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Provider saved" }).waitFor();
    await page.screenshot({ path: "/tmp/postbox-97-sso-admin.png", fullPage: true });
    const providers = await (await context.request.get(`${base}/api/admin/sso`)).json();
    expect(providers).toHaveLength(1);
    expect(providers[0]).not.toHaveProperty("secrets");
    await context.request.post(`${base}/api/auth/logout`);
    await page.goto(`${base}/login?next=/profile`);
    await page.getByRole("link", { name: "Continue with Fixture identity" }).click();
    await page.waitForURL(`${base}/profile`);
    const status = await (await context.request.get(`${base}/api/auth/status`)).json();
    expect(status.caller.user.displayName).toBe("Federated Person");
    expect(status.caller.isAdmin).toBe(false);
    expect((await context.request.get(`${base}/api/admin/sso`)).status()).toBe(403);
    await context.request.post(`${base}/api/auth/logout`);
    expect((await context.request.get(`${base}/api/me`)).status()).toBe(401);
    await page.goto(`${base}/login`);
    await page.getByPlaceholder("Username").fill("recovery-admin");
    await page.getByPlaceholder("Password", { exact: true }).fill("recovery-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(base + "/");
    expect((await (await context.request.get(`${base}/api/auth/status`)).json()).caller.isAdmin).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
    await idp.close();
  }
});
