"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { McpConnectionSummary, WorkspaceMcpBindings } from "@cloud-work/protocol";
import { api, errorMessage } from "./client";
import { ErrorBanner, Icon, Modal } from "./ui";
import { mcpConnectionLabel, McpTestStatus } from "./mcp-settings";
import { useLocale } from "./locale";

type WorkspaceMcp = WorkspaceMcpBindings;

export function WorkspaceMcp({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
    const { tr } = useLocale();
    const [connections, setConnections] = useState<McpConnectionSummary[]>([]);
    const [selected, setSelected] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [saveError, setSaveError] = useState("");
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const load = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        setLoadError("");
        try {
            const data = await api<WorkspaceMcp>(`/api/workspaces/${workspaceId}/mcp`, { signal });
            if (signal?.aborted) return;
            setConnections(data.connections);
            setSelected(data.enabledConnectionIds);
        } catch (error) {
            if (!signal?.aborted) setLoadError(errorMessage(error));
        } finally {
            if (!signal?.aborted) setLoading(false);
        }
    }, [workspaceId]);
    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);
    function close() {
        if (!saving && (!dirty || window.confirm(tr("放弃未保存的连接更改？", "Discard your unsaved workspace connection changes?")))) onClose();
    }
    async function save() {
        setSaving(true);
        setSaveError("");
        try {
            await api<WorkspaceMcp>(`/api/workspaces/${workspaceId}/mcp`, { method: "PUT", body: JSON.stringify({ connectionIds: selected }) });
            onClose();
        } catch (error) {
            setSaveError(errorMessage(error));
        } finally {
            setSaving(false);
        }
    }
    return <Modal title={tr("此工作区可用的连接", "Connections for this workspace")} description={tr("选择 Agent 在此工作区可使用的工具连接。更改从下一次提问开始生效。", "Choose the tool connections the agent can use here. Changes apply to the next question.")} onClose={close} className="mcp-bindings-modal">
        {loading ? <div className="mcp-dialog-loading"><span className="spinner"/>{tr("正在加载连接…", "Loading connections…")}</div> : loadError ? <ErrorBanner message={loadError} onRetry={() => { void load(); }}/> : connections.length === 0 ? <div className="mcp-bindings-empty"><Icon name="plug" size={28}/><p>{tr("还没有连接。", "No connections yet.")}</p><Link href="/settings/mcp" className="text-button">{tr("添加 MCP 连接", "Add an MCP connection")}</Link></div> : <div className="mcp-binding-list">{connections.map(connection => {
            const checked = selected.includes(connection.id);
            return <label className={`mcp-binding ${!connection.enabled ? "mcp-binding-disabled" : ""}`} key={connection.id}><input type="checkbox" checked={checked} aria-label={mcpConnectionLabel(connection)} disabled={saving || (!checked && (!connection.enabled || selected.length >= 16))} onChange={event => { setDirty(true); setSelected(current => event.target.checked ? [...current, connection.id] : current.filter(id => id !== connection.id)); }}/><span className="mcp-binding-copy"><strong>{mcpConnectionLabel(connection)}</strong><span className="mcp-binding-meta">{connection.enabled ? <><McpTestStatus connection={connection}/><span>{tr(`${connection.tools.length} 个工具`, `${connection.tools.length} tools`)}</span></> : <span>{tr("已在连接设置中停用", "Disabled in connection settings")}</span>}</span></span></label>;
        })}</div>}
        {saveError && <ErrorBanner message={saveError}/>}
        <div className="mcp-bindings-footer"><Link href="/settings/mcp" className="text-button small">{tr("管理所有连接", "Manage all connections")}<Icon name="arrow" size={13}/></Link>{selected.length >= 16 && <span className="small muted">{tr("当前工作区已达到连接数量上限", "This workspace has reached its connection limit")}</span>}</div>
        <div className="modal-actions"><button className="button button-secondary" disabled={saving} onClick={close}>{tr("取消", "Cancel")}</button><button className="button button-primary" disabled={saving || loading || !!loadError || !dirty} onClick={() => { void save(); }}>{saving ? <><span className="spinner"/>{tr("正在保存…", "Saving…")}</> : tr("保存连接", "Save connections")}</button></div>
    </Modal>;
}
