"use client";
import { useEffect, useReducer, useRef, useState } from "react";
import type { AgentEvent } from "@cloud-work/protocol";
import { api, errorMessage, type Session } from "./client";
import { ErrorBanner, Icon } from "./ui";
type Block = {
    key: string;
    type: "user" | "assistant" | "error";
    text: string;
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
    type: "event";
    id: string;
    event: AgentEvent;
} | {
    type: "status";
    status: string;
};
function reduce(state: State, action: Action): State {
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
        blocks.push({ key, type: "error", text: event.message });
    return { blocks, seen, status: event.type === "status" ? event.status : state.status };
}
function formatValue(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
export function Conversation({ session, onCreateSession, onStatusChange, onComplete }: {
    session: Session | null;
    onCreateSession: () => Promise<Session>;
    onStatusChange: (status: string) => void;
    onComplete: () => void;
}) {
    const [state, dispatch] = useReducer(reduce, { blocks: [], status: session?.status || "idle", seen: new Set<string>() });
    const [prompt, setPrompt] = useState("");
    const [sending, setSending] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [error, setError] = useState("");
    const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
    const [connectionAttempt, setConnectionAttempt] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const followScroll = useRef(true);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const completeRef = useRef(onComplete);
    completeRef.current = onComplete;
    const isRunning = ["starting", "running"].includes(state.status) || sending;
    useEffect(() => { onStatusChange(state.status); }, [state.status, onStatusChange]);
    useEffect(() => {
        dispatch({ type: "reset", status: session?.status || "idle" });
        setError("");
        setStopping(false);
        followScroll.current = true;
        if (!session)
            return;
        setConnection("connecting");
        const source = new EventSource(`/api/sessions/${session.id}/events`);
        source.onopen = () => setConnection("connected");
        source.onmessage = message => {
            try {
                const event = JSON.parse(message.data) as AgentEvent;
                dispatch({ type: "event", id: message.lastEventId, event });
                if (event.type === "status" && ["idle", "stopped", "error"].includes(event.status)) {
                    setStopping(false);
                    completeRef.current();
                }
            }
            catch {
                setError("An unreadable event was received. Reconnect to reload the conversation.");
            }
        };
        source.onerror = () => setConnection("reconnecting");
        return () => source.close();
        // Session status changes are received through events. Reopen only on session selection or explicit reconnect.
    }, [session?.id, connectionAttempt]);
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
            dispatch({ type: "status", status: "starting" });
            await api(`/api/sessions/${activeSession.id}/messages`, { method: "POST", body: JSON.stringify({ prompt: text }) });
            setPrompt(current => current.trim() === text ? "" : current);
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
            await api(`/api/sessions/${session.id}/cancel`, { method: "POST", body: "{}" });
        }
        catch (err) {
            setError(errorMessage(err));
            setStopping(false);
        }
    }
    return <section className="conversation"><div className="conversation-scroller" ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el)
        followScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>{state.blocks.length === 0 ? <div className="conversation-empty"><div className="agent-emblem"><Icon name="logo" size={32}/></div><div className="eyebrow">LET’S MAKE SOMETHING</div><h2>What are we working on?</h2><p>Build an idea, explore your code, or tackle a task.<br />Your agent works directly with the files in this workspace.</p><div className="prompt-suggestions">{[{ icon: "code" as const, label: "Build something", prompt: "Help me build a new project. First, ask me what I want to create." }, { icon: "folder" as const, label: "Explore these files", prompt: "Explore the files in this workspace and explain the project structure." }, { icon: "terminal" as const, label: "Find the next step", prompt: "Review this workspace and help me decide on a useful next step." }].map(item => <button key={item.label} onClick={() => { setPrompt(item.prompt); textareaRef.current?.focus(); }} disabled={isRunning}><Icon name={item.icon} size={18}/><span>{item.label}</span><Icon name="arrow" size={14}/></button>)}</div></div> : <div className="message-list" role="log" aria-label="Agent conversation" aria-live="polite" aria-relevant="additions text">{state.blocks.map((block, index) => block.type === "tool" ? <div className="tool-block" key={`${block.key}-${index}`}><details><summary><span className={`tool-state ${block.complete ? "complete" : ""}`}>{block.complete ? <Icon name="check" size={14}/> : isRunning ? <span className="spinner"/> : <Icon name="stop" size={12}/>}</span><span>{block.name}</span><span className="tool-status">{block.complete ? "Completed" : isRunning ? "Running" : "Ended"}</span><Icon name="chevron" size={13}/></summary><div className="tool-details">{block.input !== undefined && <><div className="eyebrow">INPUT</div><pre>{formatValue(block.input)}</pre></>}{block.output !== undefined && <><div className="eyebrow">RESULT</div><pre>{formatValue(block.output)}</pre></>}{block.input === undefined && block.output === undefined && <p className="muted">No additional details.</p>}</div></details></div> : block.type === "error" ? <ErrorBanner message={block.text} key={`${block.key}-${index}`}/> : <article key={`${block.key}-${index}`} className={`message message-${block.type}`}><div className={`message-avatar ${block.type === "assistant" ? "agent" : ""}`}>{block.type === "assistant" ? <Icon name="logo" size={18}/> : <span>Y</span>}</div><div className="message-body"><div className="message-author">{block.type === "assistant" ? "Cloud Work" : "You"}{block.type === "assistant" && <span>AGENT</span>}</div><div className="message-text">{block.text}</div></div></article>)}</div>}{isRunning && <div className="thinking-line" role="status"><span className="thinking-dots"><i /><i /><i /></span><span>{stopping ? "Stopping the agent…" : state.status === "starting" ? "Starting your agent…" : "Working on it…"}</span></div>}</div><div className="composer-region">{session && connection === "reconnecting" && <div className="connection-warning" role="status"><span className="status-dot status-starting"/><span>Connection interrupted. Reconnecting…</span><button className="text-button" onClick={() => setConnectionAttempt(value => value + 1)}>Reconnect</button></div>}{error && <ErrorBanner message={error} onDismiss={() => setError("")}/>}<form className={`composer ${isRunning ? "composer-running" : ""}`} onSubmit={send}><textarea ref={textareaRef} aria-label="Message your agent" placeholder="Ask your agent to build, explore, or make a change…" value={prompt} maxLength={100000} onChange={e => setPrompt(e.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void send();
    } }} rows={3}/><div className="composer-bottom"><div className="composer-context"><Icon name="folder" size={14}/><span>Workspace context</span><span className="context-divider"/><span className="muted">DSH</span></div>{isRunning ? <button type="button" className="button button-stop" onClick={() => void stop()} disabled={stopping || !session}><Icon name="stop" size={14}/>{stopping ? "Stopping…" : "Stop"}</button> : <button type="submit" className="button button-primary button-send" disabled={!prompt.trim()}><span>Send</span><Icon name="arrow" size={17}/></button>}</div></form><div className="composer-note"><span><kbd>Enter</kbd> to send · <kbd>Shift + Enter</kbd> for a new line</span><span className="conversation-status"><span className={`status-dot status-${isRunning ? "running" : state.status === "error" ? "error" : "idle"}`}/>{isRunning ? "Agent working" : state.status === "stopped" ? "Run stopped" : state.status === "error" ? "Run ended with an error" : "Ready when you are"}</span></div></div></section>;
}
