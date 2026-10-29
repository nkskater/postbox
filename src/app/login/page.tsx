import { redirect } from "next/navigation";
import { getAuthConfig } from "@/server/auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!getAuthConfig()) redirect("/");
  const { next } = await searchParams;
  // Only allow same-site relative redirects after login.
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return <LoginForm next={target} />;
}
