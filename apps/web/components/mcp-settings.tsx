"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { McpConnectionList, McpConnectionSummary } from "@cloud-work/protocol";
import { api, errorMessage, useUser } from "./client";
import { ErrorBanner, Header, Icon, LoadingScreen, Modal } from "./ui";

type ConnectionsResponse = McpConnectionList;
type ConnectionResponse = { connection: McpConnectionSummary };
const authLabels = { none: "No authentication", bearer: "Bearer token", headers: "Custom headers" };

export function McpTestStatus({ connection }: { connection: McpConnectionSummary }) {
    const text = connection.lastTestStatus === "ok" ? "Connected" : connection.lastTestStatus === "error" ? "Test failed" : "Not tested";
    return <span className={`mcp-test-status mcp-test-${connection.lastTestStatus}`}><span className="status-dot"/>{text}</span>;
}

export function McpSettings() {
    const { user, error: authError, retry } = useUser();
    const [connections, setConnections] = useState<McpConnectionSummary[]>([]);
    const [origins, setOrigins] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [actionError, setActionError] = useState("");
    const [notice, setNotice] = useState("");
    const [editing, setEditing] = useState<McpConnectionSummary | "new" | null>(null);
    const [deleting, setDeleting] = useState<McpConnectionSummary | null>(null);
    const [busy, setBusy] = useState<{ id: string; action: string } | null>(null);
    const load = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        setLoadError("");
        try {
            const data = await api<ConnectionsResponse>("/api/mcp/connections", { signal });
            if (signal?.aborted) return;
            setConnections(data.connections);
            setOrigins(data.policy.allowedOrigins);
        } catch (error) {
            if (!signal?.aborted) setLoadError(errorMessage(error));
        } finally {
            if (!signal?.aborted) setLoading(false);
        }
    }, []);
    useEffect(() => {
        if (!user) return;
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [user, load]);
    function replace(connection: McpConnectionSummary) {
        setConnections(current => current.some(item => item.id === connection.id) ? current.map(item => item.id === connection.id ? connection : item) : [connection, ...current]);
    }
    async function action(connection: McpConnectionSummary, kind: "test" | "toggle" | "delete") {
        setBusy({ id: connection.id, action: kind });
        setActionError("");
        setNotice("");
        try {
            const url = `/api/mcp/connections/${connection.id}`;
            if (kind === "delete") {
                await api(url, { method: "DELETE" });
                setConnections(current => current.filter(item => item.id !== connection.id));
                setDeleting(null);
                setNotice(`“${connection.name}” was deleted.`);
            } else {
                const result = await api<ConnectionResponse>(kind === "test" ? `${url}/test` : url, kind === "test" ? { method: "POST" } : { method: "PATCH", body: JSON.stringify({ enabled: !connection.enabled }) });
                replace(result.connection);
                setNotice(kind === "test" ? result.connection.lastTestStatus === "ok" ? `Connected to ${result.connection.name}. Found ${result.connection.tools.length} tools.` : `The test for ${connection.name} failed. See the connection for details.` : `“${connection.name}” is now ${result.connection.enabled ? "enabled" : "disabled"}.`);
            }
        } catch (error) {
            setActionError(errorMessage(error));
        } finally {
            setBusy(null);
        }
    }
    if (!user) return <LoadingScreen error={authError} retry={retry}/>;
    return <div className="dashboard mcp-page">
        <Header user={user}><span className="header-divider"/><span className="header-section">MCP connections</span></Header>
        <main className="dashboard-main mcp-main">
            <Link className="mcp-back small muted" href="/workspaces">← Back to workspaces</Link>
            <div className="dashboard-intro">
                <div><div className="eyebrow">CONNECTED TOOLS</div><h1>MCP connections<span className="heading-dot">.</span></h1><p className="muted">Connect an MCP server, then choose which workspaces can use its tools.</p></div>
                <button className="button button-primary" disabled={loading || !!loadError || origins.length === 0 || connections.length >= 32} onClick={() => { setActionError(""); setEditing("new"); }}><Icon name="plus"/>Add connection</button>
            </div>
            {!loading && !loadError && <div className="mcp-policy"><Icon name="plug" size={18}/><div><strong>HTTP connections</strong><p>{origins.length ? "Your administrator allows servers at these origins:" : "No server origins are allowed yet. Ask your administrator to configure the MCP allowlist."}</p>{origins.length > 0 && <ul>{origins.map(origin => <li key={origin}><code>{origin}</code></li>)}</ul>}</div></div>}
            {loadError && <ErrorBanner message={loadError} onRetry={() => { void load(); }}/>}
            {actionError && !deleting && <ErrorBanner message={actionError} onDismiss={() => setActionError("")}/>}
            <div className="mcp-notice" role="status">{notice || (connections.length >= 32 ? "You have reached the limit of 32 connections. Delete a connection before adding another." : "")}</div>
            <section className="mcp-connections" aria-label="MCP connections" aria-busy={loading}>
                {loading ? <div className="empty-state"><span className="spinner"/><p>Loading connections…</p></div> : !loadError && connections.length === 0 ? <div className="empty-state mcp-empty"><span className="empty-icon"><Icon name="plug" size={30}/></span><h2>Your tools, connected</h2><p>Add an HTTP MCP server to make its tools<br/>available to your workspace agent.</p><button className="button button-secondary" disabled={origins.length === 0} onClick={() => setEditing("new")}><Icon name="plus"/>Add your first connection</button></div> : connections.map(connection => <article className="mcp-card" key={connection.id}>
                    <div className="mcp-card-top"><div className="mcp-card-identity"><span className="workspace-icon color-0"><Icon name="plug" size={23}/></span><div><h2>{connection.name}</h2><p className="small muted">{connection.serverName || "MCP server"}</p></div></div><button className={`mcp-enable ${connection.enabled ? "is-enabled" : ""}`} role="switch" aria-checked={connection.enabled} aria-label={`Enable ${connection.name}`} disabled={!!busy} onClick={() => { void action(connection, "toggle"); }}><span className="mcp-switch-track"><span/></span>{connection.enabled ? "Enabled" : "Disabled"}</button></div>
                    <p className="mcp-url">{connection.url}</p>
                    <div className="mcp-meta"><span>{authLabels[connection.authType]}{connection.authType !== "none" && <span className={connection.hasSecret ? "mcp-configured" : "mcp-missing"}> · {connection.hasSecret ? "Configured" : "Not configured"}</span>}</span><McpTestStatus connection={connection}/>{connection.lastTestAt && <span>Tested {new Date(connection.lastTestAt).toLocaleString()}</span>}</div>
                    {connection.lastTestStatus === "error" && <div className="mcp-test-error"><Icon name="alert" size={16}/><p>{connection.lastTestError || "Connection test failed. Check the server URL and credentials, then test again."}</p></div>}
                    <details className="mcp-tools"><summary><Icon name="chevron" size={14}/><span>{connection.tools.length} discovered {connection.tools.length === 1 ? "tool" : "tools"}</span></summary>{connection.tools.length ? <ul>{connection.tools.map(tool => <li key={tool.name}><code>{tool.name}</code>{tool.description && <p>{tool.description}</p>}</li>)}</ul> : <p className="muted small">{connection.lastTestStatus === "never" ? "Test the connection to discover its tools." : "No tools were discovered. Test again after checking the server."}</p>}</details>
                    <div className="mcp-card-actions"><button className="button button-secondary button-small" disabled={!!busy} onClick={() => { void action(connection, "test"); }}>{busy?.id === connection.id && busy.action === "test" ? <><span className="spinner"/>Testing…</> : <><Icon name="refresh" size={14}/>Test connection</>}</button><div><button className="button button-small mcp-quiet-button" disabled={!!busy} onClick={() => setEditing(connection)}><Icon name="edit" size={14}/>Edit</button><button className="icon-button danger" aria-label={`Delete ${connection.name}`} disabled={!!busy} onClick={() => { setActionError(""); setDeleting(connection); }}><Icon name="trash" size={16}/></button></div></div>
                </article>)}
            </section>
        </main>
        {editing && <ConnectionForm key={editing === "new" ? "new" : editing.id} connection={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={connection => { replace(connection); setEditing(null); setNotice(`“${connection.name}” was saved. Test the connection to check its tools.`); }}/>}
        {deleting && <Modal title="Delete connection?" description={`“${deleting.name}” will be removed from all workspaces. Its saved credentials will be deleted.`} onClose={() => { if (!busy) { setDeleting(null); setActionError(""); } }}>{actionError && <ErrorBanner message={actionError}/>}<div className="modal-actions"><button className="button button-secondary" disabled={!!busy} onClick={() => setDeleting(null)}>Cancel</button><button className="button button-danger" disabled={!!busy} onClick={() => { void action(deleting, "delete"); }}>{busy ? <><span className="spinner"/>Deleting…</> : "Delete connection"}</button></div></Modal>}
    </div>;
}

function ConnectionForm({ connection, onClose, onSaved }: { connection: McpConnectionSummary | null; onClose: () => void; onSaved: (connection: McpConnectionSummary) => void }) {
    const [name, setName] = useState(connection?.name || "");
    const [url, setUrl] = useState(connection?.url || "");
    const [authType, setAuthType] = useState<McpConnectionSummary["authType"]>(connection?.authType || "none");
    const [token, setToken] = useState("");
    const [headerRows, setHeaderRows] = useState([{ name: "", value: "" }]);
    const [enabled, setEnabled] = useState(connection?.enabled ?? true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [dirty, setDirty] = useState(false);
    const keepsSecret = connection?.authType === authType && connection.hasSecret;
    function close() {
        if (!busy && (!dirty || window.confirm("Discard your unsaved connection changes?"))) onClose();
    }
    async function save(event: FormEvent) {
        event.preventDefault();
        setError("");
        const data: Record<string, unknown> = { name: name.trim(), url: url.trim(), authType, enabled };
        if (authType === "bearer") {
            if (token.trim()) data.token = token.trim();
            else if (!keepsSecret) { setError("Enter a bearer token for this connection."); return; }
        }
        if (authType === "headers") {
            const entered = headerRows.filter(row => row.name.trim() || row.value.trim());
            if (entered.some(row => !row.name.trim() || !row.value.trim())) { setError("Each header needs both a name and a value."); return; }
            if (new Set(entered.map(row => row.name.trim().toLowerCase())).size !== entered.length) { setError("Header names must be unique."); return; }
            if (entered.length) data.headers = Object.fromEntries(entered.map(row => [row.name.trim(), row.value.trim()]));
            else if (!keepsSecret) { setError("Add at least one authentication header."); return; }
        }
        setBusy(true);
        try {
            const result = await api<ConnectionResponse>(connection ? `/api/mcp/connections/${connection.id}` : "/api/mcp/connections", { method: connection ? "PATCH" : "POST", body: JSON.stringify(data) });
            onSaved(result.connection);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    }
    return <Modal title={connection ? "Edit connection" : "Add MCP connection"} description="Connect an HTTP MCP server. Its tools become available after you enable it in a workspace." onClose={close} className="mcp-form-modal">
        <form onSubmit={save} onChange={() => setDirty(true)}>
            <fieldset className="mcp-form-fields" disabled={busy}>
                <label>Connection name<input autoFocus required maxLength={100} placeholder="e.g. Team knowledge" value={name} onChange={event => setName(event.target.value)}/></label>
                <label>Server URL<input type="url" required maxLength={2048} placeholder="https://mcp.example.com/mcp" spellCheck={false} autoCapitalize="none" value={url} onChange={event => setUrl(event.target.value)}/><span className="mcp-field-hint">Use a server origin allowed by your administrator.</span></label>
                <label>Authentication<select value={authType} onChange={event => setAuthType(event.target.value as McpConnectionSummary["authType"])}><option value="none">None</option><option value="bearer">Bearer token</option><option value="headers">Custom headers</option></select></label>
                {authType !== "none" && <p className="mcp-secret-note">{keepsSecret ? <><Icon name="check" size={14}/>Configured. Leave the {authType === "bearer" ? "token" : "header fields"} blank to keep the saved credentials.</> : "Credentials are stored securely and never displayed after saving."}</p>}
                {authType === "bearer" && <label>{keepsSecret ? "Replace bearer token" : "Bearer token"}<input type="password" required={!keepsSecret} autoComplete="new-password" maxLength={4096} placeholder={keepsSecret ? "Leave blank to keep current token" : "Enter token"} value={token} onChange={event => setToken(event.target.value)}/></label>}
                {authType === "headers" && <div className="mcp-header-fields"><p className="mcp-field-hint">{keepsSecret ? "Entering headers replaces the complete saved header set." : "Add up to 16 authentication headers required by your server."}</p>{headerRows.map((row, index) => <div className="mcp-header-row" key={index}><label>Header name<input aria-label={`Header ${index + 1} name`} maxLength={64} autoCapitalize="none" spellCheck={false} placeholder="X-API-Key" value={row.name} onChange={event => setHeaderRows(current => current.map((item, rowIndex) => rowIndex === index ? { ...item, name: event.target.value } : item))}/></label><label>Value<input aria-label={`Header ${index + 1} value`} type="password" autoComplete="new-password" maxLength={4096} placeholder="Enter value" value={row.value} onChange={event => setHeaderRows(current => current.map((item, rowIndex) => rowIndex === index ? { ...item, value: event.target.value } : item))}/></label><button type="button" className="icon-button" aria-label={`Remove header ${index + 1}`} onClick={() => { setDirty(true); setHeaderRows(current => current.length === 1 ? [{ name: "", value: "" }] : current.filter((_, rowIndex) => rowIndex !== index)); }}><Icon name="close" size={15}/></button></div>)}<button type="button" className="text-button small" disabled={headerRows.length >= 16} onClick={() => { setHeaderRows(current => [...current, { name: "", value: "" }]); setDirty(true); }}>+ Add header</button></div>}
                <label className="mcp-checkbox-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/><span>Enable this connection<span className="mcp-field-hint">Select it in a workspace to let that agent use its tools.</span></span></label>
            </fieldset>
            {error && <ErrorBanner message={error}/>}
            <div className="modal-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={close}>Cancel</button><button className="button button-primary" disabled={busy || !name.trim() || !url.trim()}>{busy ? <><span className="spinner"/>Saving…</> : connection ? "Save changes" : "Add connection"}</button></div>
        </form>
    </Modal>;
}
