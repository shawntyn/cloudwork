"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, useUser, type Workspace } from "./client";
import { useLocale } from "./locale";
import { AppSidebar } from "./app-shell";
import { ErrorBanner, Header, Icon, LoadingScreen, Modal } from "./ui";

type PendingAction = { kind: "trash" | "purge"; workspace: Workspace } | null;
const restorable = (workspace: Workspace) => !!workspace.deletedAt && !workspace.purgeStartedAt && Date.now() - new Date(workspace.deletedAt).getTime() < 30 * 86400000;

export function WorkspaceList() {
    const { user, error: authError, retry } = useUser();
    const { tr, locale } = useLocale();
    const router = useRouter();
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [trashed, setTrashed] = useState<Workspace[]>([]);
    const [view, setView] = useState<"active" | "trash">("active");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [modal, setModal] = useState(false);
    const [pending, setPending] = useState<PendingAction>(null);
    const [confirmName, setConfirmName] = useState("");
    const [name, setName] = useState("");
    const [filter, setFilter] = useState("");
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState("");
    const [acting, setActing] = useState<string | null>(null);

    useEffect(() => {
        const open = () => setModal(true);
        window.addEventListener("cloudwork:new-workspace", open);
        if (new URLSearchParams(window.location.search).get("new") === "1") setModal(true);
        return () => window.removeEventListener("cloudwork:new-workspace", open);
    }, []);

    const refresh = useCallback(async () => {
        setError("");
        try {
            const [active, trash] = await Promise.all([
                api<{ workspaces: Workspace[] }>("/api/workspaces"),
                api<{ workspaces: Workspace[] }>("/api/workspaces?view=trash"),
            ]);
            setWorkspaces(active.workspaces);
            setTrashed(trash.workspaces);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { if (user) void refresh(); }, [user, refresh]);
    useEffect(() => {
        if (!user) return;
        const onFocus = () => { void refresh(); };
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [user, refresh]);

    async function create(event: React.FormEvent) {
        event.preventDefault();
        setCreating(true);
        setCreateError("");
        try {
            const data = await api<{ workspace: Workspace }>("/api/workspaces", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
            router.push(`/workspaces/${data.workspace.id}`);
        } catch (err) {
            setCreateError(errorMessage(err));
            setCreating(false);
        }
    }

    async function act(kind: "trash" | "restore" | "purge", workspace: Workspace) {
        setActing(workspace.id);
        setError("");
        setNotice("");
        try {
            await api(`/api/workspaces/${workspace.id}`, kind === "trash" ? { method: "DELETE" } : kind === "restore" ? { method: "PATCH" } : { method: "POST", body: JSON.stringify({ confirmName }) });
            setPending(null);
            setConfirmName("");
            window.dispatchEvent(new Event("cloudwork:workspaces-changed"));
            setNotice(kind === "trash" ? tr(`“${workspace.name}”已移入回收站，可在 30 天内恢复。`, `“${workspace.name}” moved to Trash. You can restore it within 30 days.`) : kind === "restore" ? tr(`“${workspace.name}”已恢复。`, `“${workspace.name}” was restored.`) : tr(`“${workspace.name}”已彻底删除。`, `“${workspace.name}” was permanently deleted.`));
            await refresh();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setActing(null);
        }
    }

    const items = (view === "trash" ? trashed : workspaces).filter(workspace => workspace.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
    if (!user) return <LoadingScreen error={authError} retry={retry}/>;
    return <div className="dashboard cw-shell"><AppSidebar active="workspaces"/><div className="cw-shell-main">
        <Header user={user}><span className="header-divider"/><span className="header-section">{tr("工作区", "Workspaces")}</span></Header>
        <main className="dashboard-main">
            <div className="dashboard-intro"><div><div className="eyebrow">{tr("你的工作空间", "YOUR PERSONAL WORKBENCH")}</div><h1>{tr("我的工作区", "My Workspaces")}<span className="heading-dot">.</span></h1><p className="muted">{tr("为每个项目留出空间，随时与 Agent 协作。", "A place for every project. An agent ready to help.")}</p></div><button className="button button-primary" onClick={() => setModal(true)}><Icon name="plus"/>{tr("新建工作区", "New workspace")}</button></div>
            <div className="workspace-toolbar"><div className="cw-workspace-views" aria-label={tr("工作区视图", "Workspace views")}><button type="button" aria-current={view === "active" ? "page" : undefined} className={view === "active" ? "active" : ""} onClick={() => setView("active")}>{tr("全部工作区", "Workspaces")} <span className="count">{workspaces.length}</span></button><button type="button" aria-current={view === "trash" ? "page" : undefined} className={view === "trash" ? "active" : ""} onClick={() => setView("trash")}>{tr("回收站", "Trash")} <span className="count">{trashed.length}</span></button></div><label className="cw-workspace-search"><span className="sr-only">{tr("搜索当前列表中的工作区", "Search workspaces in this view")}</span><input value={filter} onChange={event => setFilter(event.target.value)} placeholder={tr("搜索当前列表…", "Search this list…")}/></label></div>
            {notice && <div className="cw-workspace-notice" role="status">{notice}{view !== "trash" && <button className="text-button" onClick={() => { setView("trash"); setNotice(""); }}>{tr("查看回收站", "View Trash")}</button>}</div>}
            {error && !pending && <ErrorBanner message={error} onRetry={() => void refresh()} onDismiss={() => setError("")}/>}
            <section aria-label={view === "trash" ? tr("回收站", "Trash") : tr("我的工作区", "My workspaces")} className="workspace-grid">
                {loading ? <div className="empty-state"><span className="spinner"/><p>{tr("正在加载工作区…", "Loading your workspaces…")}</p></div> : items.length === 0 ? <div className="empty-state workspace-empty"><span className="empty-icon"><Icon name="folder" size={32}/></span><h2>{filter ? tr("没有匹配的工作区", "No matching workspaces") : view === "trash" ? tr("回收站为空", "Trash is empty") : tr("从新的空间开始", "A fresh space to start")}</h2>{!filter && view === "active" && <><p>{tr("创建工作区，集中管理文件、想法和 Agent 对话。", "Create a workspace to bring your files, ideas, and agent conversations together.")}</p><button className="button button-primary" onClick={() => setModal(true)}><Icon name="plus"/>{tr("创建第一个工作区", "Create your first workspace")}</button></>}</div> : items.map((workspace, index) => <article className="workspace-card" key={workspace.id}>
                    <div className="workspace-card-top"><span className={`workspace-icon color-${index % 4}`}><Icon name="folder" size={25}/></span>{view === "active" && <details className="cw-workspace-actions"><summary aria-label={tr(`管理 ${workspace.name}`, `Manage ${workspace.name}`)}>···</summary><div><button onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setPending({ kind: "trash", workspace }); }}>{tr("移到回收站", "Move to Trash")}</button></div></details>}</div>
                    {view === "active" ? <Link href={`/workspaces/${workspace.id}`} className="workspace-link"><h2>{workspace.name}</h2><div className="workspace-card-bottom"><span>{tr("创建于 ", "Created ")}{new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(workspace.createdAt))}</span><span className="open-workspace">{tr("打开工作区", "Open workspace")}<Icon name="arrow" size={16}/></span></div></Link> : <div className="workspace-link cw-trashed-card"><h2>{workspace.name}</h2><p className="small muted">{workspace.purgeStartedAt ? tr("正在彻底删除；若失败，系统会重试。", "Permanently deleting; the system will retry if needed.") : !restorable(workspace) ? tr("恢复期限已过，等待系统删除。", "Restore period ended; awaiting deletion.") : tr(`保留至 ${new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(new Date(workspace.deletedAt!).getTime() + 30 * 86400000))}`, `Kept until ${new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(new Date(workspace.deletedAt!).getTime() + 30 * 86400000))}`)}</p><div className="cw-trash-actions"><button className="button button-secondary button-small" disabled={!!acting || !restorable(workspace)} onClick={() => void act("restore", workspace)}>{tr("恢复", "Restore")}</button><button className="button button-small cw-quiet-danger" disabled={!!acting} onClick={() => { setConfirmName(""); setPending({ kind: "purge", workspace }); }}>{tr("彻底删除", "Delete permanently")}</button></div></div>}
                </article>)}
            </section>
        </main>
        {modal && <Modal title={tr("新建工作区", "New workspace")} description={tr("为项目命名。文件将存放在专属的持久目录中。", "Give your project a name. Your files will have their own persistent directory.")} onClose={() => { if (!creating) setModal(false); }}><form onSubmit={create}><label>{tr("工作区名称", "Workspace name")}<input autoFocus required maxLength={100} placeholder={tr("例如：我的下一个项目", "e.g. My next project")} value={name} onChange={e => setName(e.target.value)}/></label>{createError && <ErrorBanner message={createError}/>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setModal(false)} disabled={creating}>{tr("取消", "Cancel")}</button><button className="button button-primary" disabled={creating || !name.trim()}>{creating ? <><span className="spinner"/>{tr("正在准备工作区…", "Preparing workspace…")}</> : <>{tr("创建工作区", "Create workspace")}<Icon name="arrow" size={16}/></>}</button></div></form></Modal>}
        {pending && <Modal title={pending.kind === "trash" ? tr("移到回收站？", "Move to Trash?") : tr("彻底删除工作区？", "Delete workspace permanently?")} description={pending.kind === "trash" ? tr(`“${pending.workspace.name}”中的文件和对话将在 30 天内保留，可从回收站恢复。`, `Files and conversations in “${pending.workspace.name}” are kept for 30 days and can be restored from Trash.`) : tr(`将永久删除“${pending.workspace.name}”中的文件和对话，且无法恢复。请输入工作区名称以确认。`, `This permanently deletes the files and conversations in “${pending.workspace.name}”. Type the workspace name to confirm.`)} onClose={() => { if (!acting) setPending(null); }}>
            {pending.kind === "purge" && <label>{tr("工作区名称", "Workspace name")}<input autoFocus value={confirmName} onChange={event => setConfirmName(event.target.value)} autoComplete="off"/></label>}
            {error && <ErrorBanner message={error} onDismiss={() => setError("")}/>}
            <div className="modal-actions"><button className="button button-secondary" disabled={!!acting} onClick={() => setPending(null)}>{tr("取消", "Cancel")}</button><button className={pending.kind === "purge" ? "button button-danger" : "button button-primary"} disabled={!!acting || (pending.kind === "purge" && confirmName !== pending.workspace.name)} onClick={() => void act(pending.kind, pending.workspace)}>{acting ? tr("正在处理…", "Working…") : pending.kind === "trash" ? tr("移到回收站", "Move to Trash") : tr("彻底删除", "Delete permanently")}</button></div>
        </Modal>}
    </div></div>;
}
