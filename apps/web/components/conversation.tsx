"use client";
import { useEffect, useReducer, useRef, useState } from "react";
import type { AgentEvent } from "@cloud-work/protocol";
import { api, errorMessage, type Session } from "./client";
import { useLocale } from "./locale";
import { ErrorBanner, Icon } from "./ui";
type Block = {
    key: string;
    type: "user" | "assistant" | "error";
    text: string;
    code?: string;
} | {
    key: string;
    type: "tool";
    name: string;
    input?: unknown;
    output?: unknown;
    complete: boolean;
};
type State = {
    blocks: Block[];
    status: string;
    seen: Set<string>;
};
type Action = {
    type: "reset";
    status: string;
} | {
    type: "restore";
    state: State;
} | {
    type: "event";
    id: string;
    event: AgentEvent;
} | {
    type: "status";
    status: string;
};
function reduce(state: State, action: Action): State {
    if (action.type === "restore")
        return action.state;
    if (action.type === "reset")
        return { blocks: [], status: action.status, seen: new Set() };
    if (action.type === "status")
        return { ...state, status: action.status };
    if (action.id && state.seen.has(action.id))
        return state;
    const seen = new Set(state.seen);
    if (action.id)
        seen.add(action.id);
    const event = action.event;
    const blocks = [...state.blocks];
    const key = action.id || `${Date.now()}-${blocks.length}`;
    if (event.type === "text-delta") {
        const last = blocks[blocks.length - 1];
        if (last?.type === "assistant")
            blocks[blocks.length - 1] = { ...last, text: last.text + event.text };
        else
            blocks.push({ key, type: "assistant", text: event.text });
    }
    else if (event.type === "user-message")
        blocks.push({ key, type: "user", text: event.text });
    else if (event.type === "tool-start")
        blocks.push({ key: event.id, type: "tool", name: event.name, input: event.input, complete: false });
    else if (event.type === "tool-result") {
        const index = blocks.findLastIndex(block => block.type === "tool" && block.key === event.id);
        const tool = blocks[index];
        if (index >= 0 && tool?.type === "tool")
            blocks[index] = { ...tool, output: event.output, complete: true };
        else
            blocks.push({ key: event.id, type: "tool", name: "Tool result", output: event.output, complete: true });
    }
    else if (event.type === "error")
        blocks.push({ key, type: "error", text: event.message, code: event.code });
    return { blocks, seen, status: event.type === "status" ? event.status : state.status };
}
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
    const [rawState, dispatch] = useReducer(reduce, { blocks: [], status: session?.status || "idle", seen: new Set<string>() });
    const cacheRef = useRef<Record<string, State>>({});
    const stateKeyRef = useRef(sessionKey);
    const stateRef = useRef(rawState);
    stateRef.current = rawState;
    const state = stateKeyRef.current === sessionKey ? rawState : cacheRef.current[sessionKey] || { blocks: [], status: session?.status || "idle", seen: new Set<string>() };
    const [historyLoading, setHistoryLoading] = useState(!!session?.hasMessages);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const promptKey = sessionKey;
    const prompt = drafts[promptKey] || "";
    const setPrompt = (value: string | ((current: string) => string)) => setDrafts(current => ({ ...current, [promptKey]: typeof value === "function" ? value(current[promptKey] || "") : value }));
    const [sending, setSending] = useState(false);
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
    completeRef.current = onComplete;
    sentRef.current = onMessageSent;
    const isRunning = ["starting", "running"].includes(state.status) || sending;
    const activeTool = [...state.blocks].reverse().find(block => block.type === "tool" && !block.complete);
    useEffect(() => { if (session) onStatusChange(session.id, state.status); }, [session?.id, state.status, onStatusChange]);
    useEffect(() => {
        if (stateKeyRef.current !== sessionKey) {
            cacheRef.current[stateKeyRef.current] = stateRef.current;
            stateKeyRef.current = sessionKey;
        }
        const restored = cacheRef.current[sessionKey];
        dispatch({ type: "restore", state: restored || { blocks: [], status: session?.status || "idle", seen: new Set<string>() } });
        setHistoryLoading(!!session?.hasMessages && !restored?.blocks.length);
        setError("");
        setStopping(false);
        followScroll.current = true;
        lastEventId.current = "";
    }, [sessionKey]);
    useEffect(() => {
        if (!historyLoading) return;
        const timer = window.setTimeout(() => setHistoryLoading(false), 2000);
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
                dispatch({ type: "event", id: message.lastEventId, event });
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
    async function send(event?: React.FormEvent) {
        event?.preventDefault();
        if (!prompt.trim() || isRunning)
            return;
        const text = prompt.trim();
        setSending(true);
        setError("");
        try {
            const activeSession = session || await onCreateSession();
            if (!session) {
                setDrafts(current => ({ ...current, [activeSession.id]: text }));
                cacheRef.current[activeSession.id] = { blocks: [], status: "starting", seen: new Set<string>() };
            }
            dispatch({ type: "status", status: "starting" });
            await api("/api/sessions/" + activeSession.id + "/messages", { method: "POST", body: JSON.stringify({ prompt: text }) });
            setDrafts(current => ({ ...current, [activeSession.id]: current[activeSession.id]?.trim() === text ? "" : current[activeSession.id] || "", ...(!session ? { [promptKey]: "" } : {}) }));
            sentRef.current();
            followScroll.current = true;
        }
        catch (err) {
            setError(errorMessage(err));
            dispatch({ type: "status", status: "idle" });
        }
        finally {
            setSending(false);
            textareaRef.current?.focus();
        }
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
                        ) : block.type === "error" ? (
                            <div className="cw-run-error" key={block.key + "-" + index}><ErrorBanner message={runErrorLabel(block.text, block.code, tr)}/><details><summary>{tr("技术详情", "Technical details")}</summary><pre>{block.text}</pre></details></div>
                        ) : (
                            <article key={block.key + "-" + index} className={"message message-" + block.type}>
                                <div className={"message-avatar " + (block.type === "assistant" ? "agent" : "")}>{block.type === "assistant" ? <Icon name="logo" size={18}/> : <span>Y</span>}</div>
                                <div className="message-body">
                                    <div className="message-author">{block.type === "assistant" ? "Cloud Work" : tr("你", "You")}{block.type === "assistant" && <span>AGENT</span>}</div>
                                    <div className="message-text">{block.text}</div>
                                </div>
                            </article>
                        ))}
                    </div>
                )}
                {isRunning && <div className="thinking-line" role="status"><span className="thinking-dots"><i/><i/><i/></span><span>{stopping ? tr("正在停止 Agent…", "Stopping the agent…") : state.status === "starting" ? tr("正在启动 Agent…", "Starting your agent…") : activeTool?.type === "tool" ? tr("正在运行 ", "Running ") + activeTool.name : tr("正在处理…", "Working on it…")}</span></div>}
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
                        {isRunning ? <button type="button" className="button button-stop" onClick={() => void stop()} disabled={stopping || !session}><Icon name="stop" size={14}/>{stopping ? tr("正在停止…", "Stopping…") : tr("停止", "Stop")}</button> : <button type="submit" className="button button-primary button-send" disabled={!prompt.trim()}><span>{tr("发送", "Send")}</span><Icon name="arrow" size={17}/></button>}
                    </div>
                </form>
                <div className="composer-note">
                    <span><kbd>Enter</kbd> {tr("发送", "to send")} · <kbd>Shift + Enter</kbd> {tr("换行", "for a new line")}</span>
                    <span className="conversation-status"><span className={"status-dot status-" + (isRunning ? "running" : state.status === "error" ? "error" : "idle")}/>{isRunning ? tr("Agent 正在处理", "Agent working") : state.status === "stopped" ? tr("运行已停止", "Run stopped") : state.status === "error" ? tr("运行出错", "Run ended with an error") : tr("随时可以开始", "Ready when you are")}</span>
                </div>
            </div>
        </section>
    );
}
