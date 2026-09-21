"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, shortDate, useUser, type Runtime, type Workspace } from "./client";
import { ErrorBanner, Header, Icon, LoadingScreen, Modal, RuntimeControl } from "./ui";
export function WorkspaceList() {
    const { user, error: authError, retry } = useUser();
    const router = useRouter();
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [runtime, setRuntime] = useState<Runtime | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [modal, setModal] = useState(false);
    const [name, setName] = useState("");
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState("");
    const [removing, setRemoving] = useState<string | null>(null);
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
        if (!window.confirm(`Delete “${workspace.name}”? This permanently deletes this workspace, its files, and conversations.`))
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
    return <div className="dashboard"><Header user={user}><span className="header-divider"/><span className="header-section">Workspaces</span></Header><main className="dashboard-main"><div className="dashboard-intro"><div><div className="eyebrow">YOUR PERSONAL WORKBENCH</div><h1>My Workspaces<span className="heading-dot">.</span></h1><p className="muted">A place for every project. An agent ready to help.</p></div><button className="button button-primary" onClick={() => setModal(true)}><Icon name="plus"/>New workspace</button></div><div className="workspace-toolbar"><div className="toolbar-title"><Icon name="folder" size={17}/><span>All workspaces</span><span className="count">{workspaces.length}</span></div><RuntimeControl runtime={runtime} onChange={setRuntime}/></div>{error && <ErrorBanner message={error} onRetry={refresh} onDismiss={() => setError("")}/>}<section aria-label="My workspaces" className="workspace-grid">{loading ? <div className="empty-state"><span className="spinner"/><p>Loading your workspaces…</p></div> : workspaces.length === 0 ? <div className="empty-state workspace-empty"><span className="empty-icon"><Icon name="folder" size={32}/></span><h2>A fresh space to start</h2><p>Create a workspace to bring your files,<br />ideas, and agent conversations together.</p><button className="button button-primary" onClick={() => setModal(true)}><Icon name="plus"/>Create your first workspace</button></div> : <>{workspaces.map((workspace, index) => <article className="workspace-card" key={workspace.id}><div className="workspace-card-top"><span className={`workspace-icon color-${index % 4}`}><Icon name="folder" size={25}/></span><button className="icon-button delete-workspace" aria-label={`Delete ${workspace.name}`} title="Delete workspace" onClick={() => remove(workspace)} disabled={removing === workspace.id}><Icon name="trash" size={16}/></button></div><Link href={`/workspaces/${workspace.id}`} className="workspace-link"><h2>{workspace.name}</h2><span className="workspace-id">{workspace.id}</span><div className="workspace-card-bottom"><span>Created {shortDate(workspace.createdAt)}</span><span className="open-workspace">Open workspace<Icon name="arrow" size={16}/></span></div></Link></article>)}<button className="new-workspace-card" onClick={() => setModal(true)}><span className="new-circle"><Icon name="plus" size={25}/></span><span>Make room for another idea</span><span className="small muted">New workspace</span></button></>}</section><footer className="dashboard-footer"><div><span className="status-dot status-running"/>Persistent files. A dedicated runtime for your account.</div><span>POWERED BY DEEPSEEK HARNESS</span></footer></main>{modal && <Modal title="New workspace" description="Give your project a name. Your files will have their own persistent directory." onClose={() => { if (!creating)
        setModal(false); }}><form onSubmit={create}><label>Workspace name<input autoFocus required maxLength={100} placeholder="e.g. My next project" value={name} onChange={e => setName(e.target.value)}/></label>{createError && <ErrorBanner message={createError}/>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setModal(false)} disabled={creating}>Cancel</button><button className="button button-primary" disabled={creating || !name.trim()}>{creating ? <><span className="spinner"/>Preparing runtime…</> : <>Create workspace<Icon name="arrow" size={16}/></>}</button></div>{creating && <p className="small muted">The first workspace may take a moment while your runtime starts.</p>}</form></Modal>}</div>;
}
