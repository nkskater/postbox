import { redirect } from "next/navigation";
import { getAuthState } from "@/server/caller";
import { publicProviders } from "@/server/sso";
import { safeNext } from "@/core/sso/model";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const state = getAuthState();
  if (!state.enabled) redirect("/");
  const { next } = await searchParams;
  // Only allow same-site relative redirects after login.
  const target = safeNext(next);
  return <LoginForm next={target} accounts={state.hasUsers} providers={publicProviders()} />;
}
