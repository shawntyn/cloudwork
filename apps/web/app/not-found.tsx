import Link from "next/link";
import { Brand, Icon } from "../components/ui";

export default function NotFound() {
  return <main className="loading-screen"><Brand/><div className="empty-state"><Icon name="folder" size={30}/><h1>Nothing at this address</h1><p>This page may have moved, or the link may be incomplete.</p><Link href="/workspaces" className="button button-primary">Back to workspaces</Link></div></main>;
}
