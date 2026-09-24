"use client";
import { useEffect, useReducer, useRef, useState } from "react";
import type { AgentEvent } from "@cloud-work/protocol";
import { api, ApiClientError, errorMessage, type Session } from "./client";
import { emptyConversation, reduceConversation, type Block, type ConversationState, type UserBlock } from "./conversation-state";
import { useLocale } from "./locale";
import { ErrorBanner, Icon } from "./ui";
import { RichContent } from "./rich-content";
function formatValue(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function runErrorLabel(message: string, code: string | undefined, tr: (zh: string, en: string) => string) {
    const resolvedCode = code || (/timed?\s*out|timeout/i.test(message) ? "RUN_TIMEOUT" : "RUN_FAILED");
    if (resolvedCode === "RUN_TIMEOUT") return tr("Agent 请求超时。请重试。", "The agent request timed out. Try again.");
    if (resolvedCode === "RUN_START_FAILED") return tr("Agent 未能启动。请检查运行环境后重试。", "The agent could not start. Check the runtime and try again.");
    if (resolvedCode === "RUN_INTERRUPTED") return tr("Agent 运行被中断。工作区文件已保留，请重试。", "The agent run was interrupted. Your workspace files are preserved. Try again.");
    return tr("Agent 运行出错。请重试；可展开查看详情。", "The agent run failed. Try again, or expand for details.");
}
export function Conversation({ workspaceId, session, onCreateSession, onStatusChange, onComplete, onMessageSent }: {
    workspaceId: string;
    session: Session | null;
    onCreateSession: () => Promise<Session>;
    onStatusChange: (sessionId: string, status: string) => void;
    onComplete: () => void;
    onMessageSent: () => void;
}) {
    const { tr, locale } = useLocale();
    const sessionKey = session?.id || "draft:" + workspaceId;
    const [rawState, dispatch] = useReducer(reduceConversation, emptyConversation(session?.status || "idle"));
    const cacheRef = useRef<Record<string, ConversationState>>({});
    const stateKeyRef = useRef(sessionKey);
    const stateRef = useRef(rawState);
    stateRef.current = rawState;
    const state = stateKeyRef.current === sessionKey ? rawState : cacheRef.current[sessionKey] || emptyConversation(session?.status || "idle");
    const [historyLoading, setHistoryLoading] = useState(!!session?.hasMessages);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const promptKey = sessionKey;
    const prompt = drafts[promptKey] || "";
    const setPrompt = (value: string | ((current: string) => string)) => setDrafts(current => ({ ...current, [promptKey]: typeof value === "function" ? value(current[promptKey] || "") : value }));
    const [sending, setSending] = useState(false);
    const sendingRef = useRef(false);
    const [stopping, setStopping] = useState(false);
    const [error, setError] = useState("");
    const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
    const [connectionAttempt, setConnectionAttempt] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const followScroll = useRef(true);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const completeRef = useRef(onComplete);
    const sentRef = useRef(onMessageSent);
    const lastEventId = useRef("");
    const verificationAttempts = useRef<Record<string, number>>({});
    completeRef.current = onComplete;
    sentRef.current = onMessageSent;
    const pendingMessage = [...state.blocks].reverse().find((block): block is UserBlock => block.type === "user" && !!block.pending && block.pending !== "failed");
    const unresolved = !!pendingMessage;
    const isRunActive = ["starting", "running"].includes(state.status) || sending;
    const isRunning = isRunActive || unresolved;
    const activeTool = [...state.blocks].reverse().find(block => block.type === "tool" && !block.complete);
    const currentTurnId = [...state.blocks].reverse().find(block => block.type === "user")?.turnId;
    useEffect(() => { if (session) onStatusChange(session.id, state.status); }, [session?.id, state.status, onStatusChange]);
    useEffect(() => {
        if (stateKeyRef.current !== sessionKey) {
            cacheRef.current[stateKeyRef.current] = stateRef.current;
            stateKeyRef.current = sessionKey;
        }
        const restored = cacheRef.current[sessionKey];
        dispatch({ type: "restore", state: restored || emptyConversation(session?.status || "idle") });
        setHistoryLoading(!!session?.hasMessages && !restored?.blocks.length);
        setError("");
        setStopping(false);
        followScroll.current = true;
        lastEventId.current = "";
    }, [sessionKey]);
    useEffect(() => {
        if (!historyLoading) return;
        const timer = window.setTimeout(() => setHistoryLoading(false), 12000);
        return () => window.clearTimeout(timer);
    }, [historyLoading, sessionKey]);
    useEffect(() => {
        if (!session)
            return;
        setConnection("connecting");
        const after = lastEventId.current ? "?after=" + encodeURIComponent(lastEventId.current) : "";
        const source = new EventSource("/api/sessions/" + session.id + "/events" + after);
        source.onopen = () => setConnection("connected");
        source.onmessage = message => {
            try {
                const event = JSON.parse(message.data) as AgentEvent;
                if (event.type === "error" && "code" in event && event.code === "stream_interrupted") {
                    setConnection("reconnecting");
                    return;
                }
                setHistoryLoading(false);
                if (message.lastEventId) lastEventId.current = message.lastEventId;
                stateRef.current = reduceConversation(stateRef.current, { type: "event", id: message.lastEventId, event });
                dispatch({ type: "restore", state: stateRef.current });
                if (event.type === "status" && ["idle", "stopped", "error"].includes(event.status)) {
                    setStopping(false);
                    completeRef.current();
                }
            }
            catch {
                setError(tr("收到无法读取的事件。请重新连接。", "An unreadable event was received. Reconnect to reload the conversation."));
            }
        };
        source.onerror = () => setConnection("reconnecting");
        return () => source.close();
        // Browser EventSource resumes automatically. Explicit reconnect continues from the last event.
    }, [session?.id, connectionAttempt, locale]);
    useEffect(() => { if (followScroll.current && scrollRef.current)
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [state.blocks, state.status]);
    useEffect(() => {
        if (!session || connection !== "connected") return;
        const pending = state.blocks.filter((block): block is UserBlock => block.type === "user" && (block.pending === "verifying" || block.pending === "accepted"));
        if (!pending.length) return;
        const timer = window.setTimeout(() => {
            for (const block of pending) {
                if (!block.requestId || (verificationAttempts.current[block.requestId] || 0) >= 3) continue;
                verificationAttempts.current[block.requestId] = (verificationAttempts.current[block.requestId] || 0) + 1;
                void verifyPending(block, session, true);
            }
        }, 2500);
        return () => window.clearTimeout(timer);
    }, [session?.id, connection, state.blocks]);
    function applyLocal(action: Parameters<typeof reduceConversation>[1]) {
        stateRef.current = reduceConversation(stateRef.current, action);
        dispatch({ type: "restore", state: stateRef.current });
    }
    async function requestStatus(activeSession: Session, requestId: string) {
        return api<{ state: "accepted" | "pending" | "absent"; sessionStatus: string }>(
            "/api/sessions/" + activeSession.id + "/messages?requestId=" + encodeURIComponent(requestId));
    }
    async function verifyPending(block: UserBlock, activeSession: Session | null = session, automatic = false) {
        if (!activeSession || !block.requestId) return;
        try {
            const result = await requestStatus(activeSession, block.requestId);
            if (!stateRef.current.blocks.some(item => item.type === "user" && item.requestId === block.requestId && item.pending)) return;
            if (result.state === "accepted") {
                if (automatic && (verificationAttempts.current[block.requestId] || 0) >= 3 && !["running", "starting"].includes(result.sessionStatus)) {
                    applyLocal({ type: "pending", requestId: block.requestId });
                    setError(tr("消息已接收，但回复尚未同步。正在重新加载对话。", "The message was received, but the reply has not synced. Reloading the conversation."));
                    lastEventId.current = "";
                    setConnectionAttempt(value => value + 1);
                    return;
                }
                applyLocal({ type: "pending", requestId: block.requestId, pending: "accepted" });
                if (result.sessionStatus === "running") applyLocal({ type: "status", status: "running" });
                if (!automatic) setConnectionAttempt(value => value + 1);
            } else if (result.state === "absent" && !["running", "starting"].includes(result.sessionStatus)) {
                applyLocal({ type: "pending", requestId: block.requestId, pending: "failed", sendError: tr("消息没有发送，可安全重试。", "The message was not sent. You can retry.") });
                applyLocal({ type: "status", status: result.sessionStatus });
            } else {
                applyLocal({ type: "pending", requestId: block.requestId, pending: "verifying" });
                if (!automatic) setConnectionAttempt(value => value + 1);
            }
        } catch {
            applyLocal({ type: "pending", requestId: block.requestId, pending: "verifying", sendError: tr("暂时无法确认发送状态。请重新连接后检查。", "The send status could not be confirmed. Reconnect and check again.") });
        }
    }
    async function submit(text: string, requestId = crypto.randomUUID()) {
        if (!text.trim() || sendingRef.current || isRunning) return;
        sendingRef.current = true;
        setSending(true);
        setError("");
        applyLocal({ type: "optimistic", requestId, text });
        followScroll.current = true;
        let activeSession: Session | null = session;
        try {
            activeSession ||= await onCreateSession();
            if (!session) {
                cacheRef.current[activeSession.id] = stateRef.current;
                setDrafts(current => ({ ...current, [activeSession!.id]: current[promptKey] || text }));
            }
            await api("/api/sessions/" + activeSession.id + "/messages", { method: "POST", body: JSON.stringify({ prompt: text, requestId }) });
            applyLocal({ type: "pending", requestId, pending: "accepted" });
            setDrafts(current => ({ ...current, [activeSession!.id]: current[activeSession!.id]?.trim() === text ? "" : current[activeSession!.id] || "", ...(!session ? { [promptKey]: "" } : {}) }));
            sentRef.current();
        } catch (err) {
            if (!activeSession) {
                applyLocal({ type: "pending", requestId, pending: "failed", sendError: errorMessage(err) });
                applyLocal({ type: "status", status: "idle" });
            } else if (err instanceof ApiClientError && [400, 401, 403, 404, 413, 429].includes(err.status)) {
                applyLocal({ type: "pending", requestId, pending: "failed", sendError: errorMessage(err) });
                applyLocal({ type: "status", status: "idle" });
            } else {
                applyLocal({ type: "pending", requestId, pending: "verifying" });
                await verifyPending({ key: requestId, type: "user", text, turnId: requestId, requestId }, activeSession);
            }
        } finally {
            sendingRef.current = false;
            setSending(false);
            textareaRef.current?.focus();
        }
    }
    async function send(event?: React.FormEvent) {
        event?.preventDefault();
        if (!prompt.trim()) return;
        await submit(prompt.trim());
    }
    async function retryRun(turnId: string) {
        if (!session || isRunning) return;
        const original = state.blocks.find(block => block.type === "user" && block.turnId === turnId);
        if (!original || original.type !== "user") return;
        try {
            const result = await api<{ session: Session }>("/api/sessions/" + session.id);
            if (["starting", "running"].includes(result.session.status)) {
                setError(tr("上一次生成仍在进行，请等待或停止后重试。", "The previous run is still active. Wait or stop it before retrying."));
                return;
            }
            applyLocal({ type: "status", status: result.session.status });
            await submit(original.text);
        } catch (err) { setError(errorMessage(err)); }
    }
    function editTurn(turnId: string) {
        const original = state.blocks.find(block => block.type === "user" && block.turnId === turnId);
        if (original?.type === "user") { setPrompt(original.text); textareaRef.current?.focus(); }
    }
    async function stop() {
        if (!session || stopping)
            return;
        setStopping(true);
        setError("");
        try {
            await api("/api/sessions/" + session.id + "/cancel", { method: "POST", body: "{}" });
        }
        catch (err) {
            setError(errorMessage(err));
            setStopping(false);
        }
    }
    return (
        <section className="conversation">
            <div className="conversation-scroller" ref={scrollRef} onScroll={() => {
                const element = scrollRef.current;
                if (element) followScroll.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
            }}>
                {state.blocks.length === 0 ? (
                    session?.hasMessages && !isRunning ? (
                        <div className="cw-history-loading">
                            {historyLoading && <span className="spinner"/>}
                            <h2>{historyLoading ? tr("正在加载对话记录…", "Loading conversation history…") : tr("暂时无法显示之前的消息", "Conversation history is unavailable")}</h2>
                            <p>{historyLoading ? tr("正在读取已保存的事件。", "Reading saved events.") : tr("你可以重新连接，或继续发送消息。", "Reconnect or continue sending a message.")}</p>
                            {!historyLoading && <button className="button button-secondary" onClick={() => setConnectionAttempt(value => value + 1)}>{tr("重新连接", "Reconnect")}</button>}
                        </div>
                    ) : (
                        <div className="conversation-empty">
                            <div className="agent-emblem"><Icon name="logo" size={32}/></div>
                            <div className="eyebrow">{tr("从这里开始", "LET’S MAKE SOMETHING")}</div>
                            <h2>{tr("今天想做什么？", "What are we working on?")}</h2>
                            <p>{tr("构建想法、探索代码或完成任务。Agent 可以直接处理此工作区的文件。", "Build an idea, explore your code, or tackle a task. Your agent works directly with the files in this workspace.")}</p>
                            <div className="prompt-suggestions">
                                {[
                                    { icon: "code" as const, label: tr("构建项目", "Build something"), prompt: tr("帮我创建一个新项目。请先问我想做什么。", "Help me build a new project. First, ask me what I want to create.") },
                                    { icon: "folder" as const, label: tr("探索文件", "Explore these files"), prompt: tr("探索此工作区的文件并解释项目结构。", "Explore the files in this workspace and explain the project structure.") },
                                    { icon: "terminal" as const, label: tr("寻找下一步", "Find the next step"), prompt: tr("查看此工作区，帮我确定下一步。", "Review this workspace and help me decide on a useful next step.") },
                                ].map(item => <button key={item.label} onClick={() => { setPrompt(item.prompt); textareaRef.current?.focus(); }} disabled={isRunning}><Icon name={item.icon} size={18}/><span>{item.label}</span><Icon name="arrow" size={14}/></button>)}
                            </div>
                        </div>
                    )
                ) : (
                    <div className="message-list" role="log" aria-label={tr("Agent 对话", "Agent conversation")} aria-live="polite" aria-relevant="additions text">
                        {state.blocks.map((block, index) => block.type === "tool" ? (
                            <div className="tool-block" key={block.key + "-" + index}>
                                <details>
                                    <summary>
                                        <span className={"tool-state " + (block.complete ? "complete" : "")}>{block.complete ? <Icon name="check" size={14}/> : isRunning ? <span className="spinner"/> : <Icon name="stop" size={12}/>}</span>
                                        <span>{block.name === "Tool result" ? tr("工具结果", "Tool result") : block.name}</span>
                                        <span className="tool-status">{block.complete ? tr("已完成", "Completed") : isRunning ? tr("运行中", "Running") : tr("已结束", "Ended")}</span>
                                        <Icon name="chevron" size={13}/>
                                    </summary>
                                    <div className="tool-details">
                                        {block.input !== undefined && <><div className="eyebrow">{tr("输入", "INPUT")}</div><pre>{formatValue(block.input)}</pre></>}
                                        {block.output !== undefined && <><div className="eyebrow">{tr("结果", "RESULT")}</div><pre>{formatValue(block.output)}</pre></>}
                                        {block.input === undefined && block.output === undefined && <p className="muted">{tr("没有更多详情。", "No additional details.")}</p>}
                                    </div>
                                </details>
                            </div>
                        ) : block.type === "error" ? block.turnId !== currentTurnId ? (
                            <details className="cw-run-error cw-run-error-past" key={block.key + "-" + index}>
                                <summary><Icon name="alert" size={14}/>{tr("这次提问未完成", "This request did not finish")}</summary>
                                <p>{runErrorLabel(block.text, block.code, tr)}</p><pre>{block.text}</pre>
                            </details>
                        ) : (
                            <div className="cw-run-error" key={block.key + "-" + index}>
                                <ErrorBanner message={runErrorLabel(block.text, block.code, tr)}/>
                                <div className="cw-run-error-actions"><button className="button button-secondary" onClick={() => void retryRun(block.turnId)} disabled={isRunning}>{tr("重试这次提问", "Retry this request")}</button><button className="text-button" onClick={() => editTurn(block.turnId)}>{tr("编辑后发送", "Edit and send")}</button></div>
                                <details><summary>{tr("技术详情", "Technical details")}</summary><pre>{block.text}</pre></details>
                            </div>
                        ) : (
                            <article key={block.key + "-" + index} className={"message message-" + block.type}>
                                <div className={"message-avatar " + (block.type === "assistant" ? "agent" : "")}>{block.type === "assistant" ? <Icon name="logo" size={18}/> : <span>Y</span>}</div>
                                <div className="message-body">
                                    <div className="message-author">{block.type === "assistant" ? "Cloud Work" : tr("你", "You")}{block.type === "assistant" && <span>AGENT</span>}</div>
                                    <div className="message-text"><RichContent content={block.text} variant="chat"/></div>
                                    {block.type === "user" && block.pending && <div className={"cw-message-delivery cw-message-delivery-" + block.pending + (block.turnId !== currentTurnId ? " cw-message-delivery-past" : "")} role="status">
                                        <span>{block.pending === "sending" ? tr("正在发送…", "Sending…") : block.pending === "accepted" ? tr("已接收，等待对话同步…", "Received, syncing conversation…") : block.pending === "verifying" ? block.sendError || tr("正在确认是否已发送…", "Checking whether this was sent…") : block.turnId !== currentTurnId ? tr("这条消息未发送", "This message was not sent") : block.sendError || tr("消息未发送。", "Message was not sent.")}</span>
                                        {block.turnId !== currentTurnId ? null : block.pending === "failed" ? <><button className="text-button" onClick={() => void submit(block.text, block.requestId)}>{tr("重试发送", "Retry sending")}</button><button className="text-button" onClick={() => editTurn(block.turnId)}>{tr("编辑", "Edit")}</button></> : block.pending !== "sending" ? <button className="text-button" onClick={() => void verifyPending(block)}>{tr("检查状态", "Check status")}</button> : null}
                                    </div>}
                                </div>
                            </article>
                        ))}
                    </div>
                )}
                {isRunActive && <div className="thinking-line" role="status"><span className="thinking-dots"><i/><i/><i/></span><span>{stopping ? tr("正在停止 Agent…", "Stopping the agent…") : sending ? tr("正在发送消息…", "Sending your message…") : state.status === "starting" ? tr("正在准备 Agent…", "Preparing your agent…") : activeTool?.type === "tool" ? tr("正在运行 ", "Running ") + activeTool.name : tr("正在处理…", "Working on it…")}</span></div>}
            </div>
            <div className="composer-region">
                {session && connection === "reconnecting" && <div className="connection-warning" role="status"><span className="status-dot status-starting"/><span>{tr("连接中断，正在重连…", "Connection interrupted. Reconnecting…")}</span><button className="text-button" onClick={() => setConnectionAttempt(value => value + 1)}>{tr("重新连接", "Reconnect")}</button></div>}
                {error && <ErrorBanner message={error} onDismiss={() => setError("")}/>}
                <form className={"composer " + (isRunning ? "composer-running" : "")} onSubmit={send}>
                    <textarea ref={textareaRef} aria-label={tr("发送消息给 Agent", "Message your agent")} placeholder={tr("请 Agent 构建、探索或修改…", "Ask your agent to build, explore, or make a change…")} value={prompt} maxLength={100000} onChange={event => setPrompt(event.target.value)} onKeyDown={event => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            void send();
                        }
                    }} rows={3}/>
                    <div className="composer-bottom">
                        <div className="composer-context"><Icon name="folder" size={14}/><span>{tr("工作区上下文", "Workspace context")}</span><span className="context-divider"/><span className="muted">DSH</span></div>
                        {isRunActive ? <button type="button" className="button button-stop" onClick={() => void stop()} disabled={stopping || !session || sending}><Icon name="stop" size={14}/>{stopping ? tr("正在停止…", "Stopping…") : tr("停止", "Stop")}</button> : unresolved && pendingMessage ? <button type="button" className="button button-secondary" onClick={() => void verifyPending(pendingMessage)}>{tr("检查发送状态", "Check send status")}</button> : <button type="submit" className="button button-primary button-send" disabled={!prompt.trim()}><span>{tr("发送", "Send")}</span><Icon name="arrow" size={17}/></button>}
                    </div>
                </form>
                <div className="composer-note">
                    <span><kbd>Enter</kbd> {tr("发送", "to send")} · <kbd>Shift + Enter</kbd> {tr("换行", "for a new line")}</span>
                    <span className="conversation-status"><span className={"status-dot status-" + (isRunning ? "running" : state.status === "error" ? "error" : "idle")}/>{isRunActive ? tr("Agent 正在处理", "Agent working") : unresolved ? tr("正在确认发送状态", "Confirming send status") : state.status === "stopped" ? tr("本次生成已停止", "Run stopped") : state.status === "error" ? tr("本次生成未完成", "Run did not finish") : tr("随时可以开始", "Ready when you are")}</span>
                </div>
            </div>
        </section>
    );
}
