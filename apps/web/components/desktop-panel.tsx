"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopView } from "@cloud-work/computer";
import { api, errorMessage, computerResult } from "./client";
import { clientUuid } from "./client-uuid";
import { useLocale } from "./locale";
import { trapDialogFocus } from "./focus";

export function DesktopPanel({ workspaceId, open, onClose, onFilesChanged }: { workspaceId: string; open: boolean; onClose: () => void; onFilesChanged: () => void }) {
    const { tr, locale } = useLocale();
    const [clientId, setClientId] = useState("");
    const [view, setView] = useState<DesktopView | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [input, setInput] = useState("");
    const [steering, setSteering] = useState("");
    const [expanded, setExpanded] = useState(false);
    const frame = useRef<HTMLIFrameElement>(null);
    const panel = useRef<HTMLElement>(null);
    const endpoint = `/api/workspaces/${workspaceId}/desktop`;
    const manual = view?.mode === "manual" && view.owner === clientId;
    useEffect(() => setClientId(clientUuid()), []);
    const refresh = useCallback(async () => { setView(await api<DesktopView>(endpoint)); }, [endpoint]);
    useEffect(() => {
        if (!open) return;
        let active = true;
        const update = () => { void api<DesktopView>(endpoint).then(value => { if (active) setView(value); }).catch(err => { if (active) setError(errorMessage(err)); }); };
        update(); const timer = window.setInterval(update, 2500);
        return () => { active = false; clearInterval(timer); };
    }, [open, endpoint]);
    useEffect(() => {
        if (!open) return;
        frame.current?.contentWindow?.postMessage({ type: "desktop-control", control: manual }, window.location.origin);
    }, [manual, view?.epoch, open]);
    useEffect(() => {
        const receive = (event: MessageEvent) => { if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return; if (event.data?.type === "desktop-connected") frame.current?.contentWindow?.postMessage({ type: "desktop-control", control: manual }, window.location.origin); if (event.data?.type === "desktop-exit") { if (expanded) { setExpanded(false); panel.current?.focus(); } else onClose(); } };
        window.addEventListener("message", receive); return () => window.removeEventListener("message", receive);
    }, [manual, expanded, onClose]);
    useEffect(() => {
        if (!open) return;
        const key = (event: KeyboardEvent) => {
            if (expanded || window.matchMedia("(max-width: 1100px)").matches) trapDialogFocus(event, expanded ? panel.current : panel.current?.closest<HTMLElement>("#file-workbench") ?? null);
            if (event.key === "Escape" && event.target !== frame.current) { event.preventDefault(); if (expanded) setExpanded(false); else onClose(); }
        };
        if (!(document.activeElement instanceof Element && document.activeElement.closest(".cw-workbench-tabs"))) panel.current?.focus(); window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, [open, expanded, onClose]);
    async function operate(operation: string, extra: Record<string, unknown> = {}) {
        setBusy(true); setError("");
        try { const result = await api<{ text?: string }>(endpoint, { method: "POST", body: JSON.stringify({ operation, clientId, ...extra }) }); if (operation === "clipboard" && typeof result.text === "string") setInput(result.text); await refresh(); onFilesChanged(); return true; }
        catch (err) { setError(errorMessage(err)); return false; }
        finally { setBusy(false); }
    }
    useEffect(() => {
        if (!expanded || !open) return;
        const elements = [...document.querySelectorAll<HTMLElement>(".cw-header-wrap,.cw-topbar,.cw-sidebar,.cw-agent-panel,.cw-workbench-tabs")];
        const previous = elements.map(element => element.inert);
        elements.forEach(element => { element.inert = true; });
        return () => elements.forEach((element, index) => { element.inert = previous[index]; });
    }, [expanded, open]);
    const state = !view ? tr("正在加载…", "Loading…") : view.status === "ready" ? view.mode === "ai" ? tr("AI 正在操作", "AI is controlling") : view.mode === "manual" ? manual ? tr("由你控制", "You are in control") : tr("人工控制中", "Manual control") : view.mode === "revoking" ? tr("正在交接控制权…", "Transferring control…") : tr("电脑已就绪 · 只读观看", "Ready · View only") : view.status === "starting" ? tr("电脑正在启动…", "Starting desktop…") : view.status === "error" ? tr("电脑暂不可用", "Desktop unavailable") : tr("电脑尚未启动", "Desktop is stopped");
    const task = view?.task;
    return <section ref={panel} tabIndex={-1} className={`cw-desktop ${expanded ? "is-expanded" : ""}`} role={expanded ? "dialog" : undefined} aria-modal={expanded ? true : undefined} aria-label={tr("工作区电脑", "Workspace computer")} hidden={!open}>
        <header className="cw-desktop-heading"><div><strong>{tr("电脑", "Computer")}</strong><span role="status">{state}</span></div><button className="icon-button" onClick={() => setExpanded(value => !value)} aria-label={expanded ? tr("退出展开", "Collapse computer") : tr("展开电脑", "Expand computer")}>{expanded ? "↙" : "↗"}</button><button className="icon-button" onClick={onClose} aria-label={tr("关闭电脑面板", "Close computer panel")}>×</button></header>
        {error && <div className="cw-desktop-error" role="alert">{error}<button onClick={() => setError("")}>{tr("关闭", "Dismiss")}</button></div>}
        {!view?.enabled ? <div className="cw-desktop-empty"><h2>{tr("电脑功能尚未启用", "Computer is not enabled")}</h2><p>{tr("请联系管理员配置桌面与视觉模型。现有对话和文件功能仍可使用。", "Ask an administrator to configure the desktop and vision model. Chat and files remain available.")}</p></div> : view.status !== "ready" ? <div className="cw-desktop-empty"><div className="cw-desktop-symbol" aria-hidden="true">▣</div><h2>{tr("你的工作区电脑", "Your workspace computer")}</h2><p>{tr("只有打开电脑或任务需要操作网页时才会启动。文件与当前工作区共享。", "Starts when you open it or a task needs a browser. Files are shared with this workspace.")}</p><button className="button button-primary" disabled={busy} onClick={() => void operate("start")}>{busy ? tr("正在启动…", "Starting…") : tr("启动电脑", "Start computer")}</button></div> : <>
            <div className="cw-desktop-actions"><button className="button button-small" disabled={busy || view.mode === "revoking"} onClick={() => void operate(manual ? "release" : "take")}>{manual ? tr("交还控制权", "Release control") : tr("手动接管", "Take control")}</button><button className="button button-small" disabled={busy} onClick={() => void operate("stop")}>{tr("停止电脑", "Stop computer")}</button><span>{tr("联网电脑 · /workspace · Alt+Esc 返回", "Networked computer · /workspace · Alt+Esc to return")}</span></div>
            {open && clientId && <iframe key={`${workspaceId}:${view.epoch}`} ref={frame} className="cw-desktop-screen" title={tr("Linux 电脑画面", "Linux desktop")} src={`/desktop/viewer?workspace=${encodeURIComponent(workspaceId)}&clientId=${encodeURIComponent(clientId)}&lang=${locale}`} onLoad={() => frame.current?.contentWindow?.postMessage({ type: "desktop-control", control: manual }, window.location.origin)}/>}
            {manual && <form className="cw-desktop-input" onSubmit={event => { event.preventDefault(); if (input) void operate("input", { text: input }).then(ok => { if (ok) setInput(""); }); }}><label htmlFor="desktop-text">{tr("输入到电脑", "Type into computer")}</label><textarea id="desktop-text" rows={2} maxLength={4000} value={input} onChange={event => setInput(event.target.value)} placeholder={tr("点击电脑里的输入框后，在此输入中文或多行文字", "Focus a desktop field, then type text here")}/><button className="button button-small" disabled={busy || !input}>{tr("输入", "Type")}</button><button type="button" className="button button-small" disabled={busy} onClick={() => void operate("clipboard")}>{tr("读取电脑剪贴板", "Read desktop clipboard")}</button></form>}
        </>}
        {!!view?.queued && <p className="cw-desktop-queue" role="status">{tr(`有 ${view.queued} 个电脑任务排队中`, `${view.queued} computer task(s) queued`)}</p>}
        {task && <div className="cw-desktop-task"><div><strong>{tr("电脑任务", "Computer task")}</strong><span>{({ queued: tr("排队中", "Queued"), running: tr("执行中", "Running"), confirmation: tr("等待确认", "Awaiting confirmation"), completed: tr("已完成", "Completed"), cancelled: tr("已停止", "Stopped"), failed: tr("失败", "Failed"), interrupted: tr("已中断", "Interrupted") })[task.state]}</span></div><p>{task.goal}</p>{task.progress && <p className="muted">{task.progress}</p>}{task.result && <p>{computerResult(task.result)}</p>}
            {task.state === "confirmation" && task.confirmation?.kind === "handoff" && <div className="cw-desktop-confirm"><p>{task.confirmation.reason}</p><button className="button button-primary" disabled={busy} onClick={() => void operate("take")}>{tr("手动接管并处理", "Take control to continue")}</button></div>}
            {task.state === "confirmation" && task.confirmation?.kind === "confirmation" && <div className="cw-desktop-confirm"><p>{task.confirmation.reason}</p><pre>{JSON.stringify(task.confirmation.operation, null, 2)}</pre><button className="button button-primary" disabled={busy} onClick={() => void operate("approve", { taskId: task.id, value: (task.confirmation as unknown as { id: string }).id })}>{tr("确认此操作", "Confirm this operation")}</button></div>}
            {["queued", "running", "confirmation"].includes(task.state) && <><form onSubmit={event => { event.preventDefault(); if (steering.trim()) void operate("steer", { taskId: task.id, value: steering }).then(ok => { if (ok) setSteering(""); }); }}><label className="sr-only" htmlFor="computer-steering">{tr("补充任务要求", "Additional instruction")}</label><input id="computer-steering" maxLength={4000} value={steering} onChange={event => setSteering(event.target.value)} placeholder={tr("补充任务要求…", "Add an instruction…")}/><button className="button button-small" disabled={busy || !steering.trim()}>{tr("发送", "Send")}</button></form><button className="button button-small" disabled={busy} onClick={() => void operate("cancel", { taskId: task.id })}>{tr("停止电脑任务", "Stop computer task")}</button></>}
            {task.state === "interrupted" && <p className="muted">{tr("交还控制权后，在原对话中发送“继续”，Agent 将重新观察电脑后继续。", "Release control, then send “continue” in the original conversation. The agent will observe the current desktop before continuing.")}</p>}
        </div>}
    </section>;
}
