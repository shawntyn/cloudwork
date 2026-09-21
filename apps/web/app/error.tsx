"use client";

import Link from "next/link";
import { Brand, Icon } from "../components/ui";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="loading-screen"><Brand/><div className="empty-state"><Icon name="alert" size={30}/><h1>We couldn’t open this page</h1><p>Try loading it again, or return to your workspaces.</p><button className="button button-primary" onClick={reset}>Try again</button><Link href="/workspaces" className="text-button">Back to workspaces</Link></div></main>;
}
