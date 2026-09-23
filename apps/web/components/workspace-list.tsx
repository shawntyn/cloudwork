"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, useUser, type Runtime, type Workspace } from "./client";
import { useLocale } from "./locale";
import { AppSidebar } from "./app-shell";
import { ErrorBanner, Header, Icon, LoadingScreen, Modal, RuntimeControl } from "./ui";
export function WorkspaceList() {
    const { user, error: authError, retry } = useUser();
    const { tr, locale } = useLocale();
    const router = useRouter();
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [runtime, setRuntime] = useState<Runtime | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [modal, setModal] = useState(false);
    const [name, setName] = useState("");
    const [filter, setFilter] = useState("");
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState("");
    const [removing, setRemoving] = useState<string | null>(null);
    useEffect(() => {
        const open = () => setModal(true);
        window.addEventListener("cloudwork:new-workspace", open);
        if (new URLSearchParams(window.location.search).get("new") === "1") setModal(true);
        return () => window.removeEventListener("cloudwork:new-workspace", open);
    }, []);
    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const data = await api<{
                workspaces: Workspace[];
            }>("/api/workspaces");
            setWorkspaces(data.workspaces);
        }
        catch (err) {
            setError(errorMessage(err));
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { if (user) {
        void refresh();
        api<{
            runtime: Runtime;
        }>("/api/runtime").then(data => setRuntime(data.runtime)).catch(err => setError(errorMessage(err)));
    } }, [user, refresh]);
    async function create(event: React.FormEvent) {
        event.preventDefault();
        setCreating(true);
        setCreateError("");
        try {
            const data = await api<{
                workspace: Workspace;
            }>("/api/workspaces", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
            router.push(`/workspaces/${data.workspace.id}`);
        }
        catch (err) {
            setCreateError(errorMessage(err));
            setCreating(false);
        }
    }
    async function remove(workspace: Workspace) {
        if (!window.confirm(tr("永久删除“" + workspace.name + "”及其中的文件和对话？", "Permanently delete “" + workspace.name + "”, its files, and conversations?")))
            return;
        setRemoving(workspace.id);
        setError("");
        try {
            await api(`/api/workspaces/${workspace.id}`, { method: "DELETE" });
            setWorkspaces(items => items.filter(item => item.id !== workspace.id));
        }
        catch (err) {
            setError(errorMessage(err));
        }
        finally {
            setRemoving(null);
        }
    }
    if (!user)
        return <LoadingScreen error={authError} retry={retry}/>;
    const visibleWorkspaces = workspaces.filter(workspace => workspace.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
    return <div className="dashboard cw-shell"><AppSidebar active="workspaces"/><div className="cw-shell-main"><Header user={user}><span className="header-divider"/><span className="header-section">{tr("工作区", "Workspaces")}</span></Header><main className="dashboard-main"><div className="dashboard-intro"><div><div className="eyebrow">{tr("你的工作空间", "YOUR PERSONAL WORKBENCH")}</div><h1>{tr("我的工作区", "My Workspaces")}<span className="heading-dot">.</span></h1><p className="muted">{tr("为每个项目留出空间，随时与 Agent 协作。", "A place for every project. An agent ready to help.")}</p></div><button className="button button-primary" onClick={() => setModal(true)}><Icon name="plus"/>{tr("新建工作区", "New workspace")}</button></div><div className="workspace-toolbar"><div className="toolbar-title"><Icon name="folder" size={17}/><span>{tr("全部工作区", "All workspaces")}</span><span className="count">{workspaces.length}</span></div><label className="cw-workspace-search"><span className="sr-only">{tr("搜索工作区", "Search workspaces")}</span><input value={filter} onChange={event => setFilter(event.target.value)} placeholder={tr("搜索工作区…", "Search workspaces…")}/></label><RuntimeControl runtime={runtime} onChange={setRuntime}/></div>{error && <ErrorBanner message={error} onRetry={refresh} onDismiss={() => setError("")}/>}<section aria-label={tr("我的工作区", "My workspaces")} className="workspace-grid">{loading ? <div className="empty-state"><span className="spinner"/><p>{tr("正在加载工作区…", "Loading your workspaces…")}</p></div> : workspaces.length === 0 ? <div className="empty-state workspace-empty"><span className="empty-icon"><Icon name="folder" size={32}/></span><h2>{tr("从新的空间开始", "A fresh space to start")}</h2><p>{tr("创建工作区，集中管理文件、想法和 Agent 对话。", "Create a workspace to bring your files, ideas, and agent conversations together.")}</p><button className="button button-primary" onClick={() => setModal(true)}><Icon name="plus"/>{tr("创建第一个工作区", "Create your first workspace")}</button></div> : <>{visibleWorkspaces.length === 0 && <p className="cw-no-workspace-match">{tr("没有匹配的工作区。", "No matching workspaces.")}</p>}{visibleWorkspaces.map((workspace, index) => <article className="workspace-card" key={workspace.id}><div className="workspace-card-top"><span className={`workspace-icon color-${index % 4}`}><Icon name="folder" size={25}/></span><button className="icon-button delete-workspace" aria-label={tr("删除 ", "Delete ") + workspace.name} title={tr("删除工作区", "Delete workspace")} onClick={() => remove(workspace)} disabled={removing === workspace.id}><Icon name="trash" size={16}/></button></div><Link href={`/workspaces/${workspace.id}`} className="workspace-link"><h2>{workspace.name}</h2><div className="workspace-card-bottom"><span>{tr("创建于 ", "Created ")}{new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(workspace.createdAt))}</span><span className="open-workspace">{tr("打开工作区", "Open workspace")}<Icon name="arrow" size={16}/></span></div></Link></article>)}<button className="new-workspace-card" onClick={() => setModal(true)}><span className="new-circle"><Icon name="plus" size={25}/></span><span>{tr("开启另一个想法", "Make room for another idea")}</span><span className="small muted">{tr("新建工作区", "New workspace")}</span></button></>}</section><footer className="dashboard-footer"><div><span className="status-dot status-running"/>{tr("文件持久保存，运行环境由你的账号专用。", "Persistent files. A dedicated runtime for your account.")}</div><span>POWERED BY DEEPSEEK HARNESS</span></footer></main>{modal && <Modal title={tr("新建工作区", "New workspace")} description={tr("为项目命名。文件将存放在专属的持久目录中。", "Give your project a name. Your files will have their own persistent directory.")} onClose={() => { if (!creating)
        setModal(false); }}><form onSubmit={create}><label>{tr("工作区名称", "Workspace name")}<input autoFocus required maxLength={100} placeholder={tr("例如：我的下一个项目", "e.g. My next project")} value={name} onChange={e => setName(e.target.value)}/></label>{createError && <ErrorBanner message={createError}/>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setModal(false)} disabled={creating}>{tr("取消", "Cancel")}</button><button className="button button-primary" disabled={creating || !name.trim()}>{creating ? <><span className="spinner"/>{tr("正在准备运行环境…", "Preparing runtime…")}</> : <>{tr("创建工作区", "Create workspace")}<Icon name="arrow" size={16}/></>}</button></div>{creating && <p className="small muted">{tr("首次启动运行环境可能需要稍等。", "The first workspace may take a moment while your runtime starts.")}</p>}</form></Modal>}</div></div>;
}
