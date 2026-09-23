"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, useUser, type Runtime, type Session, type Workspace } from "./client";
import { Conversation } from "./conversation";
import { FileBrowser } from "./file-browser";
import { trapDialogFocus } from "./focus";
import { useLocale } from "./locale";
import { WorkspaceMcp } from "./workspace-mcp";
import { ErrorBanner, Header, Icon, LoadingScreen, Modal, RuntimeControl } from "./ui";

type ListResponse = { sessions: Session[]; nextCursor?: string | null };
const activity = (session: Session) => session.lastActivityAt || session.updatedAt || session.createdAt;
const sorted = (sessions: Session[]) => [...sessions].sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || activity(b).localeCompare(activity(a)));

export function WorkspaceView({ workspaceId }: { workspaceId: string }) {
    const { user, error: authError, retry } = useUser();
    const { tr, locale } = useLocale();
    const sessionLabel = (session: Session) => session.title || (session.hasMessages ? tr("历史对话", "Previous conversation") : tr("新对话", "New conversation"));
    const router = useRouter();
    const params = useSearchParams();
    const requestedId = params.get("session");
    const draft = params.get("draft") === "1";
    const [workspace, setWorkspace] = useState<Workspace | null>(null);
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [runtime, setRuntime] = useState<Runtime | null>(null);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [sidebarSessions, setSidebarSessions] = useState<Session[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [search, setSearch] = useState("");
    const [archived, setArchived] = useState(false);
    const [sidebarBusy, setSidebarBusy] = useState(false);
    const [sidebarError, setSidebarError] = useState("");
    const [sidebarRevision, setSidebarRevision] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [creating, setCreating] = useState(false);
    const [statuses, setStatuses] = useState<Record<string, string>>({});
    const [filesRevision, setFilesRevision] = useState(0);
    const [filesOpen, setFilesOpen] = useState(false);
    const [mobile, setMobile] = useState(false);
    const [small, setSmall] = useState(false);
    const [dockWidth, setDockWidth] = useState(440);
    const [navOpen, setNavOpen] = useState(false);
    const [mcpOpen, setMcpOpen] = useState(false);
    const [renaming, setRenaming] = useState<Session | null>(null);
    const [newTitle, setNewTitle] = useState("");
    const [saving, setSaving] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(new Set([workspaceId]));
    const listRequest = useRef(0);
    const navTriggerRef = useRef<HTMLButtonElement>(null);
    const navCloseRef = useRef<HTMLButtonElement>(null);
    const navRef = useRef<HTMLElement>(null);
    const fileCloseRequestRef = useRef<(() => void) | null>(null);

    const active = useMemo(() => draft ? null : requestedId ? sessions.find(item => item.id === requestedId) || null : sorted(sessions.filter(item => !item.archivedAt))[0] || null, [draft, requestedId, sessions]);
    const invalidSelection = !loading && workspace?.id === workspaceId && !!requestedId && !active;
    const anyRunning = [...sessions, ...sidebarSessions].some(item => ["starting", "running"].includes(statuses[item.id] || item.status));
    const href = (session: Session) => "/workspaces/" + (session.workspaceId || workspaceId) + "?session=" + encodeURIComponent(session.id);

    const refreshSessions = useCallback(async () => {
        const data = await api<{ sessions: Session[] }>("/api/workspaces/" + workspaceId + "/sessions");
        setSessions(data.sessions);
        setStatuses(current => {
            const next = { ...current };
            for (const session of data.sessions) next[session.id] = session.status;
            return next;
        });
    }, [workspaceId]);
    const refreshSidebar = useCallback(async (cursor?: string) => {
        const request = ++listRequest.current;
        setSidebarBusy(true);
        setSidebarError("");
        try {
            const queryParams = new URLSearchParams({ view: archived ? "archived" : "active", limit: "100" });
            if (search.trim()) queryParams.set("q", search.trim());
            if (cursor) queryParams.set("cursor", cursor);
            const data = await api<ListResponse>("/api/sessions?" + queryParams);
            if (request !== listRequest.current) return;
            setSidebarSessions(current => cursor ? [...current, ...data.sessions.filter(item => !current.some(existing => existing.id === item.id))] : data.sessions);
            setStatuses(current => {
                const next = { ...current };
                for (const session of data.sessions) next[session.id] = session.status;
                return next;
            });
            setNextCursor(data.nextCursor || null);
        } catch (err) {
            if (request === listRequest.current) setSidebarError(errorMessage(err));
        } finally {
            if (request === listRequest.current) setSidebarBusy(false);
        }
    }, [archived, search]);
    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const [detail, workspaceData, sessionData] = await Promise.all([
                api<{ workspace: Workspace; runtime: Runtime }>("/api/workspaces/" + workspaceId),
                api<{ workspaces: Workspace[] }>("/api/workspaces"),
                api<{ sessions: Session[] }>("/api/workspaces/" + workspaceId + "/sessions"),
            ]);
            setWorkspace(detail.workspace);
            setRuntime(detail.runtime);
            setWorkspaces(workspaceData.workspaces);
            setSessions(sessionData.sessions);
            setStatuses(Object.fromEntries(sessionData.sessions.map(session => [session.id, session.status])));
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [workspaceId]);
    useEffect(() => { if (user) void load(); }, [user, load]);
    useEffect(() => { const timer = window.setTimeout(() => setSearch(query), 220); return () => window.clearTimeout(timer); }, [query]);
    useEffect(() => { if (user) void refreshSidebar(); }, [user, refreshSidebar, sidebarRevision]);
    useEffect(() => {
        if (!workspace) return;
        const timer = window.setInterval(() => {
            void api<{ runtime: Runtime }>("/api/runtime").then(data => setRuntime(data.runtime)).catch(() => {});
            void refreshSessions().catch(() => {});
            setSidebarRevision(value => value + 1);
        }, 15000);
        return () => window.clearInterval(timer);
    }, [workspace, refreshSessions]);
    useEffect(() => {
        if (!loading && workspace && !requestedId && !draft && active) router.replace(href(active), { scroll: false });
    }, [loading, workspace, requestedId, draft, active, router]);
    useEffect(() => {
        const value = Number(window.localStorage.getItem("cloud-work-dock-width"));
        if (Number.isFinite(value) && value >= 320) setDockWidth(Math.min(720, value));
    }, []);
    useEffect(() => {
        const media = window.matchMedia("(max-width: 1100px)");
        const update = () => setMobile(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);
    useEffect(() => {
        const media = window.matchMedia("(max-width: 760px)");
        const update = () => setSmall(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);
    useEffect(() => {
        if (!small || !navOpen) return;
        navCloseRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            trapDialogFocus(event, navRef.current);
            if (event.key === "Escape") {
                event.preventDefault();
                closeNavigation();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [small, navOpen]);

    function closeNavigation() {
        setNavOpen(false);
        window.requestAnimationFrame(() => navTriggerRef.current?.focus());
    }

    const complete = useCallback(() => {
        setFilesRevision(value => value + 1);
        void api<{ runtime: Runtime }>("/api/runtime").then(data => setRuntime(data.runtime)).catch(() => {});
        void refreshSessions().catch(() => {});
        setSidebarRevision(value => value + 1);
    }, [refreshSessions]);
    function select(session: Session) {
        setNavOpen(false);
        router.push(href(session), { scroll: false });
    }
    async function createSession() {
        setCreating(true);
        setError("");
        try {
            const data = await api<{ session: Session }>("/api/workspaces/" + workspaceId + "/sessions", { method: "POST", body: "{}" });
            setSessions(current => [data.session, ...current.filter(item => item.id !== data.session.id)]);
            setSidebarRevision(value => value + 1);
            router.replace(href(data.session), { scroll: false });
            return data.session;
        } catch (err) {
            setError(errorMessage(err));
            throw err;
        } finally {
            setCreating(false);
        }
    }
    function newConversation() {
        const focus = () => window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".cw-agent-panel .composer textarea")?.focus());
        if (creating) return;
        if (draft || (active && !active.hasMessages)) { focus(); setNavOpen(false); return; }
        const reusable = sorted(sessions.filter(item => !item.hasMessages && !item.archivedAt))[0];
        if (reusable) select(reusable);
        else router.push("/workspaces/" + workspaceId + "?draft=1", { scroll: false });
        setNavOpen(false);
        focus();
    }
    async function changeSession(session: Session, change: "rename" | "pin" | "archive", title?: string) {
        setSaving(true);
        setError("");
        try {
            const body = change === "rename" ? { title } : change === "pin" ? { pinned: !session.pinnedAt } : { archived: !session.archivedAt };
            const data = await api<{ session: Session }>("/api/sessions/" + session.id, { method: "PATCH", body: JSON.stringify(body) });
            setSessions(current => current.map(item => item.id === session.id ? data.session : item));
            setSidebarRevision(value => value + 1);
            if (change === "archive" && session.id === active?.id && !session.archivedAt) {
                const next = sorted(sessions.filter(item => item.id !== session.id && !item.archivedAt))[0];
                router.replace(next ? href(next) : "/workspaces/" + workspaceId + "?draft=1", { scroll: false });
            }
            setRenaming(null);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setSaving(false);
        }
    }
    function resize(event: React.PointerEvent<HTMLDivElement>) {
        if (window.matchMedia("(max-width: 760px)").matches) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = dockWidth;
        const width = (x: number) => Math.max(320, Math.min(720, window.innerWidth - 420, startWidth + startX - x));
        const move = (next: PointerEvent) => setDockWidth(width(next.clientX));
        const stop = (next: PointerEvent) => {
            window.localStorage.setItem("cloud-work-dock-width", String(width(next.clientX)));
            window.removeEventListener("pointermove", move);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop, { once: true });
    }
    function resizeWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
        const max = Math.min(720, window.innerWidth - 420);
        let next = dockWidth;
        if (event.key === "ArrowLeft") next += 20;
        else if (event.key === "ArrowRight") next -= 20;
        else if (event.key === "Home") next = 320;
        else if (event.key === "End") next = max;
        else return;
        event.preventDefault();
        next = Math.max(320, Math.min(max, next));
        setDockWidth(next);
        window.localStorage.setItem("cloud-work-dock-width", String(next));
    }
    const grouped = workspaces.map(item => ({ workspace: item, sessions: sorted(sidebarSessions.filter(session => session.workspaceId === item.id)) })).filter(item => !search || item.workspace.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) || item.sessions.length > 0);
    const title = active ? sessionLabel(active) : tr("新对话", "New conversation");

    if (!user) return <LoadingScreen error={authError} retry={retry}/>;
    return <div className="ide cw-app"><div className="cw-header-wrap" inert={(filesOpen && mobile) || (navOpen && small)}><Header user={user}><span className="header-divider"/><Link href="/workspaces" className="breadcrumb">{tr("工作区", "Workspaces")}</Link><Icon name="chevron" size={13}/><span className="current-workspace">{workspace?.name || tr("正在打开工作区", "Opening workspace")}</span></Header></div>
        {loading ? <div className="workspace-loading"><span className="spinner"/><h2>{tr("正在准备工作区", "Preparing your workspace")}</h2><p className="muted">{tr("正在恢复对话和文件。", "Restoring conversations and files.")}</p></div> : !workspace ? <div className="workspace-loading"><ErrorBanner message={error || tr("无法打开此工作区。", "This workspace could not be opened.")} onRetry={load}/><Link className="button button-secondary" href="/workspaces">{tr("返回工作区", "Back to workspaces")}</Link></div> : <>
        <div className="ide-toolbar cw-topbar" inert={(filesOpen && mobile) || (navOpen && small)}><div className="ide-toolbar-title"><button ref={navTriggerRef} className="icon-button cw-nav-toggle" aria-label={tr("打开导航", "Open navigation")} aria-expanded={navOpen} aria-controls="workspace-navigation" onClick={() => setNavOpen(true)}><Icon name="menu"/></button><span className="workspace-mini-icon"><Icon name="folder" size={17}/></span><span>{workspace.name}</span><Icon name="chevron" size={12}/><strong className="cw-topbar-session">{draft ? tr("新对话草稿", "New conversation draft") : title}</strong></div><div className="ide-toolbar-actions"><button className="button button-small cw-files-open" onClick={() => setFilesOpen(true)} aria-label={tr("打开文件工作台", "Open file workbench")} aria-expanded={filesOpen} aria-controls="file-workbench"><Icon name="folder" size={15}/><span>{tr("文件", "Files")}</span></button><button className="button button-small mcp-toolbar-button" aria-label={tr("工作区连接", "Workspace connections")} aria-haspopup="dialog" onClick={() => setMcpOpen(true)}><Icon name="plug" size={15}/><span>{tr("连接", "Connections")}</span></button><RuntimeControl runtime={runtime} onChange={value => { setRuntime(value); if (["RUNNING", "IDLE"].includes(value.status)) setFilesRevision(revision => revision + 1); }} disabled={anyRunning}/></div></div>
        {error && <div inert={(filesOpen && mobile) || (navOpen && small)}><ErrorBanner message={error} onDismiss={() => setError("")}/></div>}
        <div className="ide-body cw-body">
            {navOpen && <button className="cw-nav-scrim" aria-label={tr("关闭导航", "Close navigation")} onClick={closeNavigation}/>}
            <aside ref={navRef} id="workspace-navigation" className={"cw-sidebar " + (navOpen ? "is-open" : "")} inert={(filesOpen && mobile) || (small && !navOpen)} aria-hidden={small && !navOpen} role={small && navOpen ? "dialog" : undefined} aria-modal={small && navOpen ? true : undefined} aria-label={tr("工作区与对话", "Workspaces and conversations")}>
                <div className="cw-sidebar-head"><span className="cw-sidebar-caption">{tr("工作区", "WORKSPACES")}</span><Link href="/workspaces" className="icon-button" aria-label={tr("查看所有工作区", "View all workspaces")}><Icon name="arrow" size={16}/></Link><button ref={navCloseRef} className="icon-button cw-sidebar-close" aria-label={tr("关闭导航", "Close navigation")} onClick={closeNavigation}><Icon name="close" size={16}/></button></div>
                <button className="cw-new-chat" onClick={newConversation} disabled={creating}><Icon name="plus" size={17}/>{tr("新对话", "New conversation")}</button>
                <label className="cw-search"><span className="sr-only">{tr("搜索工作区或对话标题", "Search workspace or conversation titles")}</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={tr("搜索工作区或对话…", "Search workspaces or conversations…")}/></label>
                <div className="cw-sidebar-filter"><button className={!archived ? "active" : ""} onClick={() => setArchived(false)}>{tr("最近", "Recent")}</button><button className={archived ? "active" : ""} onClick={() => setArchived(true)}>{tr("已归档", "Archived")}</button></div>
                <div className="cw-sidebar-list">{sidebarError && <ErrorBanner message={sidebarError} onRetry={() => void refreshSidebar()}/>}
                    {grouped.length === 0 && !sidebarBusy && <p className="cw-sidebar-empty">{query ? tr("没有匹配的工作区或对话。", "No matching workspaces or conversations.") : tr("还没有对话。", "No conversations yet.")}</p>}
                    {grouped.map(group => <section className="cw-workspace-group" key={group.workspace.id}><div className="cw-workspace-row"><button className="cw-group-toggle" onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(group.workspace.id)) next.delete(group.workspace.id); else next.add(group.workspace.id); return next; })} aria-label={tr("切换对话列表", "Toggle conversation list")} aria-expanded={expanded.has(group.workspace.id)}><Icon name="chevron" size={12} className={expanded.has(group.workspace.id) ? "down" : ""}/></button><Link className={group.workspace.id === workspaceId ? "current" : ""} href={"/workspaces/" + group.workspace.id} onClick={() => setNavOpen(false)}><Icon name="folder" size={15}/><span>{group.workspace.name}</span></Link><span className="cw-group-count">{group.sessions.length}</span></div>{expanded.has(group.workspace.id) && <div className="cw-session-list">{group.sessions.map(session => <div className={"cw-session-row " + (active?.id === session.id ? "selected" : "")} key={session.id}><button className="cw-session-link" onClick={() => select(session)} title={sessionLabel(session)}><span className={"status-dot status-" + (["starting", "running"].includes(statuses[session.id] || session.status) ? "running" : "idle")}/><span>{sessionLabel(session)}</span>{["starting", "running"].includes(statuses[session.id] || session.status) && <span className="cw-running-pill">{tr("运行中", "Running")}</span>}{session.pinnedAt && <span className="cw-pin-mark" aria-label={tr("已置顶", "Pinned")}>◆</span>}</button><details className="cw-session-menu"><summary aria-label={tr("对话操作", "Conversation actions")}>···</summary><div><button onClick={() => { setRenaming(session); setNewTitle(session.title || ""); }}>{tr("重命名", "Rename")}</button><button onClick={() => void changeSession(session, "pin")} disabled={saving}>{session.pinnedAt ? tr("取消置顶", "Unpin") : tr("置顶", "Pin")}</button><button onClick={() => void changeSession(session, "archive")} disabled={saving}>{session.archivedAt ? tr("取消归档", "Unarchive") : tr("归档", "Archive")}</button></div></details></div>)}{group.sessions.length === 0 && <span className="cw-group-empty">{archived ? tr("没有已归档对话", "No archived conversations") : tr("没有对话", "No conversations")}</span>}</div>}</section>)}
                    {nextCursor && <button className="cw-load-more" disabled={sidebarBusy} onClick={() => void refreshSidebar(nextCursor)}>{sidebarBusy ? tr("加载中…", "Loading…") : tr("加载更多", "Load more")}</button>}
                </div><div className="cw-sidebar-footer"><Link href="/workspaces">{tr("管理工作区", "Manage workspaces")}</Link><Link href="/settings/mcp">{tr("连接设置", "Connection settings")}</Link></div>
            </aside>
            <main className="agent-panel cw-agent-panel" inert={(filesOpen && mobile) || (navOpen && small)}><div className="panel-heading conversation-heading cw-conversation-heading"><div><Icon name="message" size={17}/><h1 title={title}>{draft ? tr("新对话草稿", "New conversation draft") : title}</h1></div><span className="cw-heading-meta">{active ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(activity(active))) : tr("发送消息后保存", "Saved when you send")}</span></div>{invalidSelection ? <div className="cw-invalid-session"><Icon name="alert" size={24}/><h2>{tr("无法打开此对话", "This conversation is unavailable")}</h2><p>{tr("它可能已被删除，或不属于当前工作区。", "It may have been deleted or belongs to another workspace.")}</p><Link className="button button-secondary" href={"/workspaces/" + workspaceId}>{tr("返回工作区对话", "Back to workspace conversations")}</Link></div> : <Conversation workspaceId={workspaceId} session={active} onCreateSession={createSession} onStatusChange={(id, status) => setStatuses(current => current[id] === status ? current : { ...current, [id]: status })} onComplete={complete} onMessageSent={() => { void refreshSessions().catch(() => {}); setSidebarRevision(value => value + 1); }}/>}</main>
            {filesOpen && mobile && <button className="cw-file-scrim" aria-label={tr("关闭文件工作台", "Close file workbench")} onClick={() => fileCloseRequestRef.current?.()}/>}<div id="file-workbench" className={"cw-file-dock " + (filesOpen ? "is-open" : "")} style={{ width: filesOpen ? dockWidth : 0 }} role={mobile ? "dialog" : undefined} aria-modal={mobile ? true : undefined} aria-label={mobile ? tr("文件工作台", "File workbench") : undefined} aria-hidden={!filesOpen} inert={!filesOpen}><div className="cw-dock-resizer" role="separator" tabIndex={filesOpen && !mobile ? 0 : -1} aria-label={tr("调整文件工作台宽度", "Resize file workbench")} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={720} aria-valuenow={dockWidth} onPointerDown={resize} onKeyDown={resizeWithKeyboard}/><FileBrowser workspaceId={workspaceId} revision={filesRevision} open={filesOpen} onClose={() => setFilesOpen(false)} closeRequestRef={fileCloseRequestRef}/></div>
        </div></>}
        {mcpOpen && <WorkspaceMcp workspaceId={workspaceId} onClose={() => setMcpOpen(false)}/>}
        {renaming && <Modal title={tr("重命名对话", "Rename conversation")} onClose={() => setRenaming(null)}><form onSubmit={event => { event.preventDefault(); if (newTitle.trim()) void changeSession(renaming, "rename", newTitle.trim()); }}><label>{tr("对话标题", "Conversation title")}<input autoFocus maxLength={120} value={newTitle} onChange={event => setNewTitle(event.target.value)}/></label><div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setRenaming(null)}>{tr("取消", "Cancel")}</button><button className="button button-primary" disabled={saving || !newTitle.trim()}>{tr("保存", "Save")}</button></div></form></Modal>}
    </div>;
}
