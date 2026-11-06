"use client";

import Link from "next/link";
import { Brand, Icon } from "../components/ui";
import { useLocale } from "../components/locale";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { tr } = useLocale();
  return <main className="loading-screen"><Brand/><div className="empty-state"><Icon name="alert" size={30}/><h1>{tr("无法打开此页面", "We couldn’t open this page")}</h1><p>{tr("请重试，或返回工作区。", "Try loading it again, or return to your workspaces.")}</p><button className="button button-primary" onClick={reset}>{tr("重试", "Try again")}</button><Link href="/workspaces" className="text-button">{tr("返回工作区", "Back to workspaces")}</Link></div></main>;
}
