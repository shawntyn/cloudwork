"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type Session, type Workspace } from "./client";
import { trapDialogFocus } from "./focus";
import { useLocale } from "./locale";
import { ErrorBanner, Icon } from "./ui";

export function AppSidebar({ active }: { active: "workspaces" | "settings" }) {
    const { tr, locale } = useLocale();
    const sessionLabel = (session: Session) => session.title || (session.hasMessages ? tr("对话 · ", "Conversation · ") + new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(session.lastActivityAt)) : tr("新对话", "New conversation"));
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [query, setQuery] = useState("");
    const [search, setSearch] = useState("");
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loadingSessions, setLoadingSessions] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [open, setOpen] = useState(false);
    const [small, setSmall] = useState(false);
    const requestRef = useRef(0);
    const loadedBeyondFirst = useRef(false);
    const sessionQuery = useRef("");
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
    const loadWorkspaces = useCallback(async () => {
        try { const data = await api<{ workspaces: Workspace[] }>("/api/workspaces"); setWorkspaces(data.workspaces); }
        catch (error) { setLoadError(errorMessage(error)); }
    }, []);
    useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces]);
    useEffect(() => {
        window.addEventListener("cloudwork:workspaces-changed", loadWorkspaces);
        return () => window.removeEventListener("cloudwork:workspaces-changed", loadWorkspaces);
    }, [loadWorkspaces]);
    useEffect(() => { const timer = window.setTimeout(() => setSearch(query), 220); return () => window.clearTimeout(timer); }, [query]);
    const loadSessions = useCallback(async (cursor?: string) => {
        const request = ++requestRef.current;
        setLoadingSessions(true);
        setLoadError("");
        try {
            const params = new URLSearchParams({ view: "active", limit: "100" });
            if (search.trim()) params.set("q", search.trim());
            if (cursor) params.set("cursor", cursor);
            const data = await api<{ sessions: Session[]; nextCursor: string | null }>("/api/sessions?" + params);
            if (request !== requestRef.current) return;
            const sameQuery = sessionQuery.current === search;
            setSessions(current => cursor ? [...current, ...data.sessions.filter(item => !current.some(existing => existing.id === item.id))] : sameQuery && loadedBeyondFirst.current ? [...data.sessions, ...current.filter(item => !data.sessions.some(fresh => fresh.id === item.id))] : data.sessions);
            if (!cursor) { if (!sameQuery) loadedBeyondFirst.current = false; sessionQuery.current = search; }
            else loadedBeyondFirst.current = true;
            if (cursor || !sameQuery || !loadedBeyondFirst.current) setNextCursor(data.nextCursor);
        } catch (error) {
            if (request === requestRef.current) setLoadError(errorMessage(error));
        } finally {
            if (request === requestRef.current) setLoadingSessions(false);
        }
    }, [search]);
    useEffect(() => { void loadSessions(); }, [loadSessions]);
    useEffect(() => {
        const timer = window.setInterval(() => { void loadSessions(); void loadWorkspaces(); }, 15000);
        return () => window.clearInterval(timer);
    }, [loadSessions, loadWorkspaces]);
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
            <label className="cw-search"><span className="sr-only">{tr("搜索所有工作区和对话", "Search all workspaces and conversations")}</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={tr("搜索所有工作区和对话…", "Search all workspaces and conversations…")}/></label>
            <nav className="cw-shell-nav" aria-label={tr("工作区导航", "Workspace navigation")}>
                <Link className={active === "workspaces" ? "active" : ""} href="/workspaces" onClick={() => setOpen(false)}><Icon name="folder" size={16}/>{tr("所有工作区", "All workspaces")}</Link>
                <Link className={active === "settings" ? "active" : ""} href="/settings/mcp" onClick={() => setOpen(false)}><Icon name="plug" size={16}/>{tr("连接设置", "Connection settings")}</Link>
            </nav>
            <div className="cw-shell-list">{loadError && <ErrorBanner message={loadError} onRetry={() => { void Promise.all([loadWorkspaces(), loadSessions()]); }}/>}{groups.map(group => <section className="cw-workspace-group" key={group.workspace.id}><div className="cw-workspace-row"><Link href={"/workspaces/" + group.workspace.id} onClick={() => setOpen(false)}><Icon name="folder" size={15}/><span>{group.workspace.name}</span></Link></div>{group.sessions.length > 0 && <div className="cw-session-list">{group.sessions.map(session => <Link className="cw-shell-session" href={"/workspaces/" + group.workspace.id + "?session=" + encodeURIComponent(session.id)} key={session.id} onClick={() => setOpen(false)}>{["starting", "running"].includes(session.status) && <span className="status-dot status-running"/>}<span className="cw-session-title">{sessionLabel(session)}</span>{["starting", "running"].includes(session.status) && <span className="cw-running-pill">{tr("运行中", "Running")}</span>}</Link>)}</div>}</section>)}{nextCursor && <button className="cw-load-more" disabled={loadingSessions} onClick={() => void loadSessions(nextCursor)}>{loadingSessions ? tr("加载中…", "Loading…") : tr("加载更多", "Load more")}</button>}</div>
        </aside>
    </>;
}
