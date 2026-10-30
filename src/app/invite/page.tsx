import { InviteForm } from "./InviteForm";
export const dynamic = "force-dynamic";
export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  return <InviteForm token={(await searchParams).token ?? ""} />;
}
