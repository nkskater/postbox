import { App } from "@/components/app/App";

export const dynamic = "force-dynamic";

export default function Home() {
  const authEnabled = !!(process.env.POSTBOX_PASSWORD || process.env.POSTBOX_TOKEN);
  return <App authEnabled={authEnabled} />;
}
