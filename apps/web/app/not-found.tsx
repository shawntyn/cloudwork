"use client";

import Link from "next/link";
import { Brand, Icon } from "../components/ui";
import { useLocale } from "../components/locale";

export default function NotFound() {
  const { tr } = useLocale();
  return <main className="loading-screen"><Brand/><div className="empty-state"><Icon name="folder" size={30}/><h1>{tr("找不到这个页面", "Nothing at this address")}</h1><p>{tr("页面可能已移动，或链接不完整。", "This page may have moved, or the link may be incomplete.")}</p><Link href="/workspaces" className="button button-primary">{tr("返回工作区", "Back to workspaces")}</Link></div></main>;
}
