import { App } from "@/components/app/App";
import { getAuthState } from "@/server/caller";

export const dynamic = "force-dynamic";

export default function Home() {
  const authEnabled = getAuthState().enabled;
  return <App authEnabled={authEnabled} />;
}
