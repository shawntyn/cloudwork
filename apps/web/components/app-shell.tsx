"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Session, type Workspace } from "./client";
import { trapDialogFocus } from "./focus";
import { useLocale } from "./locale";
import { Icon } from "./ui";

export function AppSidebar({ active }: { active: "workspaces" | "settings" }) {
    const { tr } = useLocale();
    const sessionLabel = (session: Session) => session.title || (session.hasMessages ? tr("历史对话", "Previous conversation") : tr("新对话", "New conversation"));
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [query, setQuery] = useState("");
    const [search, setSearch] = useState("");
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loadingSessions, setLoadingSessions] = useState(false);
    const [open, setOpen] = useState(false);
    const [small, setSmall] = useState(false);
    const requestRef = useRef(0);
    const menuRef = useRef<HTMLButtonElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    const sidebarRef = useRef<HTMLElement>(null);
    useEffect(() => {
        const media = window.matchMedia("(max-width: 760px)");
        const update = () => setSmall(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);
    useEffect(() => {
        const main = sidebarRef.current?.parentElement?.querySelector<HTMLElement>(".cw-shell-main");
        if (!main) return;
        main.inert = small && open;
        return () => { main.inert = false; };
    }, [small, open]);
    useEffect(() => {
        if (!small || !open) return;
        closeRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            trapDialogFocus(event, sidebarRef.current);
            if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                menuRef.current?.focus();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [small, open]);
    useEffect(() => {
        void api<{ workspaces: Workspace[] }>("/api/workspaces").then(data => setWorkspaces(data.workspaces)).catch(() => {});
    }, []);
    useEffect(() => { const timer = window.setTimeout(() => setSearch(query), 220); return () => window.clearTimeout(timer); }, [query]);
    const loadSessions = useCallback(async (cursor?: string) => {
        const request = ++requestRef.current;
        setLoadingSessions(true);
        try {
            const params = new URLSearchParams({ view: "active", limit: "100" });
            if (search.trim()) params.set("q", search.trim());
            if (cursor) params.set("cursor", cursor);
            const data = await api<{ sessions: Session[]; nextCursor: string | null }>("/api/sessions?" + params);
            if (request !== requestRef.current) return;
            setSessions(current => cursor ? [...current, ...data.sessions.filter(item => !current.some(existing => existing.id === item.id))] : data.sessions);
            setNextCursor(data.nextCursor);
        } catch {
            if (request === requestRef.current) setNextCursor(null);
        } finally {
            if (request === requestRef.current) setLoadingSessions(false);
        }
    }, [search]);
    useEffect(() => { void loadSessions(); }, [loadSessions]);
    useEffect(() => {
        const timer = window.setInterval(() => { void loadSessions(); }, 15000);
        return () => window.clearInterval(timer);
    }, [loadSessions]);
    const matching = (value: string) => value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
    const groups = workspaces.map(workspace => ({
        workspace,
        sessions: sessions.filter(session => session.workspaceId === workspace.id && (matching(workspace.name) || matching(session.title || ""))),
    })).filter(group => !query || matching(group.workspace.name) || group.sessions.length > 0);
    function newWorkspace() {
        setOpen(false);
        if (active === "workspaces") window.dispatchEvent(new Event("cloudwork:new-workspace"));
    }
    return <>
        <button ref={menuRef} className="cw-shell-menu icon-button" aria-label={tr("打开导航", "Open navigation")} aria-expanded={open} aria-controls="site-navigation" onClick={() => setOpen(true)}><Icon name="menu"/></button>
        {open && <button className="cw-shell-scrim" aria-label={tr("关闭导航", "Close navigation")} onClick={() => { setOpen(false); window.requestAnimationFrame(() => menuRef.current?.focus()); }}/>}
        <aside ref={sidebarRef} id="site-navigation" className={"cw-shell-sidebar " + (open ? "is-open" : "")} aria-label={tr("网站导航", "Site navigation")} aria-hidden={small && !open} inert={small && !open} role={small && open ? "dialog" : undefined} aria-modal={small && open ? true : undefined}>
            <div className="cw-sidebar-head"><span className="cw-sidebar-caption">CLOUD WORK</span><button ref={closeRef} className="icon-button cw-sidebar-close" aria-label={tr("关闭导航", "Close navigation")} onClick={() => { setOpen(false); menuRef.current?.focus(); }}><Icon name="close" size={16}/></button></div>
            {active === "workspaces" ? <button className="cw-new-chat" onClick={newWorkspace}><Icon name="plus" size={17}/>{tr("新建工作区", "New workspace")}</button> : <Link className="cw-new-chat" href="/workspaces?new=1" onClick={() => setOpen(false)}><Icon name="plus" size={17}/>{tr("新建工作区", "New workspace")}</Link>}
            <label className="cw-search"><span className="sr-only">{tr("搜索工作区或对话", "Search workspaces or conversations")}</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={tr("搜索工作区或对话…", "Search workspaces or conversations…")}/></label>
            <nav className="cw-shell-nav" aria-label={tr("工作区导航", "Workspace navigation")}>
                <Link className={active === "workspaces" ? "active" : ""} href="/workspaces" onClick={() => setOpen(false)}><Icon name="folder" size={16}/>{tr("所有工作区", "All workspaces")}</Link>
                <Link className={active === "settings" ? "active" : ""} href="/settings/mcp" onClick={() => setOpen(false)}><Icon name="plug" size={16}/>{tr("连接设置", "Connection settings")}</Link>
            </nav>
            <div className="cw-shell-list">{groups.map(group => <section className="cw-workspace-group" key={group.workspace.id}><div className="cw-workspace-row"><Link href={"/workspaces/" + group.workspace.id} onClick={() => setOpen(false)}><Icon name="folder" size={15}/><span>{group.workspace.name}</span></Link></div>{group.sessions.length > 0 && <div className="cw-session-list">{group.sessions.map(session => <Link className="cw-shell-session" href={"/workspaces/" + group.workspace.id + "?session=" + encodeURIComponent(session.id)} key={session.id} onClick={() => setOpen(false)}><span className={"status-dot status-" + (["starting", "running"].includes(session.status) ? "running" : "idle")}/><span>{sessionLabel(session)}</span>{["starting", "running"].includes(session.status) && <span className="cw-running-pill">{tr("运行中", "Running")}</span>}</Link>)}</div>}</section>)}{nextCursor && <button className="cw-load-more" disabled={loadingSessions} onClick={() => void loadSessions(nextCursor)}>{loadingSessions ? tr("加载中…", "Loading…") : tr("加载更多", "Load more")}</button>}</div>
        </aside>
    </>;
}
