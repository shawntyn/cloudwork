"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, useUser, type Runtime, type Session, type Workspace } from "./client";
import { Conversation } from "./conversation";
import { FileBrowser } from "./file-browser";
import { WorkspaceMcp } from "./workspace-mcp";
import { ErrorBanner, Header, Icon, LoadingScreen, RuntimeControl } from "./ui";
export function WorkspaceView({ workspaceId }: {
    workspaceId: string;
}) {
    const { user, error: authError, retry } = useUser();
    const [workspace, setWorkspace] = useState<Workspace | null>(null);
    const [runtime, setRuntime] = useState<Runtime | null>(null);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [activeSession, setActiveSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [creatingSession, setCreatingSession] = useState(false);
    const [runStatus, setRunStatus] = useState("idle");
    const [filesRevision, setFilesRevision] = useState(0);
    const [filesOpen, setFilesOpen] = useState(false);
    const [mcpOpen, setMcpOpen] = useState(false);
    const isRunning = ["starting", "running"].includes(runStatus);
    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const detail = await api<{
                workspace: Workspace;
                runtime: Runtime;
            }>(`/api/workspaces/${workspaceId}`);
            setWorkspace(detail.workspace);
            setRuntime(detail.runtime);
            const data = await api<{
                sessions: Session[];
            }>(`/api/workspaces/${workspaceId}/sessions`);
            const sorted = data.sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            setSessions(sorted);
            setActiveSession(sorted[0] || null);
        }
        catch (err) {
            setError(errorMessage(err));
        }
        finally {
            setLoading(false);
        }
    }, [workspaceId]);
    useEffect(() => { if (user)
        void load(); }, [user, load]);
    useEffect(() => {
        if (!workspace)
            return;
        const timer = window.setInterval(() => { api<{
            runtime: Runtime;
        }>("/api/runtime").then(data => setRuntime(data.runtime)).catch(() => { }); }, 15000);
        return () => window.clearInterval(timer);
    }, [workspace]);
    const complete = useCallback(() => {
        setFilesRevision(value => value + 1);
        api<{
            runtime: Runtime;
        }>("/api/runtime").then(data => setRuntime(data.runtime)).catch(() => { });
    }, []);
    async function createSession() {
        setCreatingSession(true);
        setError("");
        try {
            const data = await api<{
                session: Session;
            }>(`/api/workspaces/${workspaceId}/sessions`, { method: "POST", body: "{}" });
            setSessions(current => [data.session, ...current]);
            setActiveSession(data.session);
            return data.session;
        }
        catch (err) {
            setError(errorMessage(err));
            throw err;
        }
        finally {
            setCreatingSession(false);
        }
    }
    if (!user)
        return <LoadingScreen error={authError} retry={retry}/>;
    return <div className="ide"><Header user={user}><span className="header-divider"/><Link href="/workspaces" className="breadcrumb">Workspaces</Link><Icon name="chevron" size={13}/><span className="current-workspace">{workspace?.name || "Opening workspace"}</span></Header>{loading ? <div className="workspace-loading"><span className="spinner"/><h2>Preparing your workspace</h2><p className="muted">Starting your runtime and restoring your files.</p></div> : !workspace ? <div className="workspace-loading"><ErrorBanner message={error || "This workspace could not be opened."} onRetry={load}/><Link className="button button-secondary" href="/workspaces">Back to workspaces</Link></div> : <><div className="ide-toolbar"><div className="ide-toolbar-title"><button className="icon-button mobile-only" aria-label="Show files" onClick={() => setFilesOpen(true)}><Icon name="menu"/></button><span className="workspace-mini-icon"><Icon name="folder" size={17}/></span><span>{workspace.name}</span><span className="toolbar-separator"/><span className="small muted">Agent workspace</span></div><div className="ide-toolbar-actions"><button className="button button-small mcp-toolbar-button" aria-label="Workspace MCP connections" title="Workspace connections" aria-haspopup="dialog" onClick={() => setMcpOpen(true)}><Icon name="plug" size={15}/><span>Connections</span></button><RuntimeControl runtime={runtime} onChange={value => { setRuntime(value); if (["RUNNING", "IDLE"].includes(value.status))
        setFilesRevision(revision => revision + 1); }} disabled={isRunning}/></div></div>{error && <ErrorBanner message={error} onDismiss={() => setError("")}/>}<div className="ide-body"><FileBrowser workspaceId={workspaceId} revision={filesRevision} open={filesOpen} onClose={() => setFilesOpen(false)}/><main className="agent-panel"><div className="panel-heading conversation-heading"><div><Icon name="message" size={17}/><h1>Agent conversation</h1></div><div className="session-controls">{sessions.length > 0 && <select aria-label="Select conversation" value={activeSession?.id || ""} disabled={creatingSession || isRunning} onChange={event => setActiveSession(sessions.find(item => item.id === event.target.value) || null)}>{sessions.map((session, index) => <option key={session.id} value={session.id}>Conversation {sessions.length - index} · {new Date(session.createdAt).toLocaleDateString("en", { month: "short", day: "numeric" })}</option>)}</select>}<button className="icon-button" aria-label="New conversation" title="New conversation" disabled={creatingSession || isRunning} onClick={() => { void createSession().catch(() => { }); }}>{creatingSession ? <span className="spinner"/> : <Icon name="plus" size={18}/>}</button></div></div><Conversation session={activeSession} onCreateSession={createSession} onStatusChange={setRunStatus} onComplete={complete}/></main></div></>}{mcpOpen && <WorkspaceMcp workspaceId={workspaceId} onClose={() => setMcpOpen(false)}/>}</div>;
}
