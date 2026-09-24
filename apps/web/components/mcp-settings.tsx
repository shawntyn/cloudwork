"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { McpConnectionList, McpConnectionSummary } from "@cloud-work/protocol";
import { api, errorMessage, useUser } from "./client";
import { ErrorBanner, Header, Icon, LoadingScreen, Modal } from "./ui";
import { useLocale } from "./locale";
import { AppSidebar } from "./app-shell";

type ConnectionsResponse = McpConnectionList;
type ConnectionResponse = { connection: McpConnectionSummary };

export function mcpConnectionLabel(connection: Pick<McpConnectionSummary, "name" | "serverName">) {
    return connection.name.trim() || connection.serverName;
}

export function McpTestStatus({ connection }: { connection: McpConnectionSummary }) {
    const { tr } = useLocale();
    const text = connection.lastTestStatus === "ok" ? tr("已连接", "Connected") : connection.lastTestStatus === "error" ? tr("测试失败", "Test failed") : tr("未测试", "Not tested");
    return <span className={`mcp-test-status mcp-test-${connection.lastTestStatus}`}><span className="status-dot"/>{text}</span>;
}

export function McpSettings() {
    const { tr, locale } = useLocale();
    const authLabels = { none: tr("无需认证", "No authentication"), bearer: tr("Bearer 令牌", "Bearer token"), headers: tr("自定义请求头", "Custom headers") };
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
                setNotice(tr(`已删除“${mcpConnectionLabel(connection)}”。`, `“${mcpConnectionLabel(connection)}” was deleted.`));
            } else {
                const result = await api<ConnectionResponse>(kind === "test" ? `${url}/test` : url, kind === "test" ? { method: "POST" } : { method: "PATCH", body: JSON.stringify({ enabled: !connection.enabled }) });
                replace(result.connection);
                setNotice(kind === "test" ? result.connection.lastTestStatus === "ok" ? tr(`已连接 ${mcpConnectionLabel(result.connection)}，找到 ${result.connection.tools.length} 个工具。`, `Connected to ${mcpConnectionLabel(result.connection)}. Found ${result.connection.tools.length} tools.`) : tr(`${mcpConnectionLabel(connection)} 测试失败，请查看详情。`, `The test for ${mcpConnectionLabel(connection)} failed. See the connection for details.`) : tr(`“${mcpConnectionLabel(connection)}”已${result.connection.enabled ? "启用" : "停用"}。`, `“${mcpConnectionLabel(connection)}” is now ${result.connection.enabled ? "enabled" : "disabled"}.`));
            }
        } catch (error) {
            setActionError(errorMessage(error));
        } finally {
            setBusy(null);
        }
    }
    if (!user) return <LoadingScreen error={authError} retry={retry}/>;
    return <div className="dashboard mcp-page cw-shell"><AppSidebar active="settings"/><div className="cw-shell-main">
        <Header user={user}><span className="header-divider"/><span className="header-section">{tr("连接管理", "Connection management")}</span></Header>
        <main className="dashboard-main mcp-main">
            <Link className="mcp-back small muted" href="/workspaces">{tr("← 返回工作区", "← Back to workspaces")}</Link>
            <div className="dashboard-intro">
                <div><div className="eyebrow"> {tr("连接工具", "CONNECTED TOOLS")}</div><h1>{tr("连接管理", "Connection management")}<span className="heading-dot">.</span></h1><p className="muted"> {tr("连接 MCP 服务器，再选择哪些工作区可以使用它的工具。", "Connect an MCP server, then choose which workspaces can use its tools.")}</p></div>
                <button className="button button-primary" disabled={loading || !!loadError || origins.length === 0 || connections.length >= 32} onClick={() => { setActionError(""); setEditing("new"); }}><Icon name="plus"/>{tr("添加连接", "Add connection")}</button>
            </div>
            {!loading && !loadError && <div className="mcp-policy"><Icon name="plug" size={18}/><div><strong>{tr("HTTP 连接", "HTTP connections")}</strong><p>{origins.length ? tr("管理员允许连接以下来源：", "Your administrator allows servers at these origins:") : tr("尚未允许任何服务器来源。请联系管理员配置 MCP 允许列表。", "No server origins are allowed yet. Ask your administrator to configure the MCP allowlist.")}</p>{origins.length > 0 && <ul>{origins.map(origin => <li key={origin}><code>{origin}</code></li>)}</ul>}</div></div>}
            {loadError && <ErrorBanner message={loadError} onRetry={() => { void load(); }}/>}
            {actionError && !deleting && <ErrorBanner message={actionError} onDismiss={() => setActionError("")}/>}
            <div className="mcp-notice" role="status">{notice || (connections.length >= 32 ? tr("最多可添加 32 个连接。请先删除一个连接。", "You have reached the limit of 32 connections. Delete a connection before adding another.") : "")}</div>
            <section className="mcp-connections" aria-label={tr("连接管理", "Connection management")} aria-busy={loading}>
                {loading ? <div className="empty-state"><span className="spinner"/><p>{tr("正在加载连接…", "Loading connections…")}</p></div> : !loadError && connections.length === 0 ? <div className="empty-state mcp-empty"><span className="empty-icon"><Icon name="plug" size={30}/></span><h2>{tr("连接你的工具", "Your tools, connected")}</h2><p>{tr("添加 HTTP MCP 服务器，让工作区 Agent 使用它的工具。", "Add an HTTP MCP server to make its tools available to your workspace agent.")}</p><button className="button button-secondary" disabled={origins.length === 0} onClick={() => setEditing("new")}><Icon name="plus"/>{tr("添加第一个连接", "Add your first connection")}</button></div> : connections.map(connection => <article className="mcp-card" key={connection.id}>
                    <div className="mcp-card-top"><div className="mcp-card-identity"><span className="workspace-icon color-0"><Icon name="plug" size={23}/></span><div><h2>{mcpConnectionLabel(connection)}</h2></div></div><button className={`mcp-enable ${connection.enabled ? "is-enabled" : ""}`} role="switch" aria-checked={connection.enabled} aria-label={tr(`启用 ${mcpConnectionLabel(connection)}`, `Enable ${mcpConnectionLabel(connection)}`)} disabled={!!busy} onClick={() => { void action(connection, "toggle"); }}><span className="mcp-switch-track"><span/></span>{connection.enabled ? tr("已启用", "Enabled") : tr("已停用", "Disabled")}</button></div>
                    <p className="mcp-url">{connection.url}</p>
                    <div className="mcp-meta"><span>{authLabels[connection.authType]}{connection.authType !== "none" && <span className={connection.hasSecret ? "mcp-configured" : "mcp-missing"}> · {connection.hasSecret ? tr("已配置", "Configured") : tr("未配置", "Not configured")}</span>}</span><McpTestStatus connection={connection}/>{connection.lastTestAt && <span>{tr("测试于", "Tested")} {new Date(connection.lastTestAt).toLocaleString(locale)}</span>}</div>
                    {connection.lastTestStatus === "error" && <div className="mcp-test-error"><Icon name="alert" size={16}/><div><p>{tr("连接测试失败。请检查服务器地址和凭据后重试。", "Connection test failed. Check the server URL and credentials, then test again.")}</p>{connection.lastTestError && <details><summary>{tr("技术详情", "Technical details")}</summary><pre>{connection.lastTestError}</pre></details>}</div></div>}
                    <details className="mcp-tools"><summary><Icon name="chevron" size={14}/><span>{tr(`发现 ${connection.tools.length} 个工具`, `${connection.tools.length} discovered ${connection.tools.length === 1 ? "tool" : "tools"}`)}</span></summary>{connection.tools.length ? <ul>{connection.tools.map(tool => <li key={tool.name}><code>{tool.name}</code>{tool.description && <p>{tool.description}</p>}</li>)}</ul> : <p className="muted small">{connection.lastTestStatus === "never" ? tr("测试连接以发现工具。", "Test the connection to discover its tools.") : tr("未发现工具，请检查服务器后重新测试。", "No tools were discovered. Test again after checking the server.")}</p>}</details>
                    <div className="mcp-card-actions"><button className="button button-secondary button-small" disabled={!!busy} onClick={() => { void action(connection, "test"); }}>{busy?.id === connection.id && busy.action === "test" ? <><span className="spinner"/>{tr("正在测试…", "Testing…")}</> : <><Icon name="refresh" size={14}/>{tr("测试连接", "Test connection")}</>}</button><div><button className="button button-small mcp-quiet-button" disabled={!!busy} onClick={() => setEditing(connection)}><Icon name="edit" size={14}/>{tr("编辑", "Edit")}</button><button className="icon-button danger" aria-label={tr(`删除 ${mcpConnectionLabel(connection)}`, `Delete ${mcpConnectionLabel(connection)}`)} disabled={!!busy} onClick={() => { setActionError(""); setDeleting(connection); }}><Icon name="trash" size={16}/></button></div></div>
                </article>)}
            </section>
        </main>
        </div>
        {editing && <ConnectionForm key={editing === "new" ? "new" : editing.id} connection={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={connection => { replace(connection); setEditing(null); setNotice(tr(`已保存“${mcpConnectionLabel(connection)}”。请测试连接以确认工具可用。`, `“${mcpConnectionLabel(connection)}” was saved. Test the connection to check its tools.`)); }}/>}
        {deleting && <Modal title={tr("删除连接？", "Delete connection?")} description={tr(`“${mcpConnectionLabel(deleting)}”将从所有工作区移除，已保存的凭据也会删除。`, `“${mcpConnectionLabel(deleting)}” will be removed from all workspaces. Its saved credentials will be deleted.`)} onClose={() => { if (!busy) { setDeleting(null); setActionError(""); } }}>{actionError && <ErrorBanner message={actionError}/>}<div className="modal-actions"><button className="button button-secondary" disabled={!!busy} onClick={() => setDeleting(null)}> {tr("取消", "Cancel")}</button><button className="button button-danger" disabled={!!busy} onClick={() => { void action(deleting, "delete"); }}>{busy ? <><span className="spinner"/>{tr("正在删除…", "Deleting…")}</> : tr("删除连接", "Delete connection")}</button></div></Modal>}
    </div>;
}

function ConnectionForm({ connection, onClose, onSaved }: { connection: McpConnectionSummary | null; onClose: () => void; onSaved: (connection: McpConnectionSummary) => void }) {
    const { tr } = useLocale();
    const [name, setName] = useState(connection?.name || "");
    const [serverName, setServerName] = useState(connection?.serverName || "");
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
        if (!busy && (!dirty || window.confirm(tr("放弃未保存的连接更改？", "Discard your unsaved connection changes?")))) onClose();
    }
    async function save(event: FormEvent) {
        event.preventDefault();
        setError("");
        const data: Record<string, unknown> = { name: name.trim(), url: url.trim(), authType, enabled };
        if (!connection) {
            if (!/^[a-z0-9_]{1,24}$/.test(serverName.trim())) { setError(tr("名称需使用 1–24 个小写字母、数字或下划线。", "Name must use 1–24 lowercase letters, numbers, or underscores.")); return; }
            data.serverName = serverName.trim();
        }
        if (authType === "bearer") {
            if (token.trim()) data.token = token.trim();
            else if (!keepsSecret) { setError(tr("请输入此连接的 Bearer 令牌。", "Enter a bearer token for this connection.")); return; }
        }
        if (authType === "headers") {
            const entered = headerRows.filter(row => row.name.trim() || row.value.trim());
            if (entered.some(row => !row.name.trim() || !row.value.trim())) { setError(tr("每个请求头都需要名称和值。", "Each header needs both a name and a value.")); return; }
            if (new Set(entered.map(row => row.name.trim().toLowerCase())).size !== entered.length) { setError(tr("请求头名称不能重复。", "Header names must be unique.")); return; }
            if (entered.length) data.headers = Object.fromEntries(entered.map(row => [row.name.trim(), row.value.trim()]));
            else if (!keepsSecret) { setError(tr("请添加至少一个认证请求头。", "Add at least one authentication header.")); return; }
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
    return <Modal title={connection ? tr("编辑连接", "Edit connection") : tr("添加 MCP 连接", "Add MCP connection")} description={tr("连接 HTTP MCP 服务器，并在工作区中启用它的工具。", "Connect an HTTP MCP server. Its tools become available after you enable it in a workspace.")} onClose={close} className="mcp-form-modal">
        <form onSubmit={save} onChange={() => setDirty(true)}>
            <fieldset className="mcp-form-fields" disabled={busy}>
                <label htmlFor="mcp-server-name">{tr("标识名称", "Name")}<input id="mcp-server-name" autoFocus={!connection} required readOnly={!!connection} maxLength={connection ? undefined : 24} pattern={connection ? undefined : "[a-z0-9_]{1,24}"} title={tr("使用 1–24 个小写字母、数字或下划线。", "Use 1–24 lowercase letters, numbers, or underscores.")} placeholder="e.g. sales_prod" spellCheck={false} autoCapitalize="none" autoCorrect="off" aria-describedby="mcp-server-name-hint mcp-tool-name-preview" value={serverName} onChange={event => { event.currentTarget.setCustomValidity(""); setServerName(event.target.value); }} onBlur={event => { event.currentTarget.setCustomValidity(""); setServerName(event.target.value.trim()); }} onInvalid={event => event.currentTarget.setCustomValidity(tr("名称需使用 1–24 个小写字母、数字或下划线。", "Name must use 1–24 lowercase letters, numbers, or underscores."))}/><span id="mcp-server-name-hint" className="mcp-field-hint">{connection ? tr("用于工具名称，创建后无法修改。", "Used in tool names. This name cannot be changed.") : tr("使用 1–24 个小写字母、数字或下划线。名称不能重复，创建后不可修改。", "Use 1–24 lowercase letters, numbers, or underscores. Must be unique among your connections and cannot be changed after creation.")}</span><span id="mcp-tool-name-preview" className="mcp-field-hint"> {tr("工具名称：", "Tool name:")} <code>{`mcp__${serverName.trim() || "name"}__tool_name`}</code></span></label>
                <label htmlFor="mcp-display-name">{tr("显示名称（可选）", "Display name (optional)")}<input id="mcp-display-name" autoFocus={!!connection} maxLength={100} placeholder={tr("例如：销售数据库", "e.g. Sales database")} aria-describedby="mcp-display-name-hint" value={name} onChange={event => setName(event.target.value)}/><span id="mcp-display-name-hint" className="mcp-field-hint">{tr("支持任意语言。留空则显示标识名称。当前显示：", "Supports any language. Leave blank to display Name. Shown as:")} {name.trim() || serverName.trim() || tr("名称", "Name")}.</span></label>
                <label>{tr("服务器地址", "Server URL")}<input type="url" required maxLength={2048} placeholder="https://mcp.example.com/mcp" spellCheck={false} autoCapitalize="none" value={url} onChange={event => setUrl(event.target.value)}/><span className="mcp-field-hint">{tr("请使用管理员允许的服务器来源。", "Use a server origin allowed by your administrator.")}</span></label>
                <label>{tr("认证方式", "Authentication")}<select value={authType} onChange={event => setAuthType(event.target.value as McpConnectionSummary["authType"])}><option value="none">{tr("无需认证", "None")}</option><option value="bearer">{tr("Bearer 令牌", "Bearer token")}</option><option value="headers">{tr("自定义请求头", "Custom headers")}</option></select></label>
                {authType !== "none" && <p className="mcp-secret-note">{keepsSecret ? <><Icon name="check" size={14}/>{tr(`已配置。留空${authType === "bearer" ? "令牌" : "请求头"}可保留已保存的凭据。`, `Configured. Leave the ${authType === "bearer" ? "token" : "header fields"} blank to keep the saved credentials.`)}</> : tr("凭据会安全保存，保存后不再显示。", "Credentials are stored securely and never displayed after saving.")}</p>}
                {authType === "bearer" && <label>{keepsSecret ? tr("替换 Bearer 令牌", "Replace bearer token") : tr("Bearer 令牌", "Bearer token")}<input type="password" required={!keepsSecret} autoComplete="new-password" maxLength={4096} placeholder={keepsSecret ? tr("留空以保留当前令牌", "Leave blank to keep current token") : tr("输入令牌", "Enter token")} value={token} onChange={event => setToken(event.target.value)}/></label>}
                {authType === "headers" && <div className="mcp-header-fields"><p className="mcp-field-hint">{keepsSecret ? tr("输入请求头将替换所有已保存的请求头。", "Entering headers replaces the complete saved header set.") : tr("最多添加 16 个服务器需要的认证请求头。", "Add up to 16 authentication headers required by your server.")}</p>{headerRows.map((row, index) => <div className="mcp-header-row" key={index}><label>{tr("请求头名称", "Header name")}<input aria-label={tr(`第 ${index + 1} 个请求头名称`, `Header ${index + 1} name`)} maxLength={64} autoCapitalize="none" spellCheck={false} placeholder="X-API-Key" value={row.name} onChange={event => setHeaderRows(current => current.map((item, rowIndex) => rowIndex === index ? { ...item, name: event.target.value } : item))}/></label><label>{tr("值", "Value")}<input aria-label={tr(`第 ${index + 1} 个请求头的值`, `Header ${index + 1} value`)} type="password" autoComplete="new-password" maxLength={4096} placeholder={tr("输入值", "Enter value")} value={row.value} onChange={event => setHeaderRows(current => current.map((item, rowIndex) => rowIndex === index ? { ...item, value: event.target.value } : item))}/></label><button type="button" className="icon-button" aria-label={tr(`删除第 ${index + 1} 个请求头`, `Remove header ${index + 1}`)} onClick={() => { setDirty(true); setHeaderRows(current => current.length === 1 ? [{ name: "", value: "" }] : current.filter((_, rowIndex) => rowIndex !== index)); }}><Icon name="close" size={15}/></button></div>)}<button type="button" className="text-button small" disabled={headerRows.length >= 16} onClick={() => { setHeaderRows(current => [...current, { name: "", value: "" }]); setDirty(true); }}>+ {tr("添加请求头", "Add header")}</button></div>}
                <label className="mcp-checkbox-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/><span>{tr("启用此连接", "Enable this connection")}<span className="mcp-field-hint">{tr("在工作区中选择此连接，让 Agent 使用它的工具。", "Select it in a workspace to let that agent use its tools.")}</span></span></label>
            </fieldset>
            {error && <ErrorBanner message={error}/>}
            <div className="modal-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={close}> {tr("取消", "Cancel")}</button><button className="button button-primary" disabled={busy || !serverName.trim() || !url.trim()}>{busy ? <><span className="spinner"/> {tr("正在保存…", "Saving…")}</> : connection ? tr("保存更改", "Save changes") : tr("添加连接", "Add connection")}</button></div>
        </form>
    </Modal>;
}
