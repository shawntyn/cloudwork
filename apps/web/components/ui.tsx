"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { api, errorMessage, type User, type Runtime } from "./client";
export type IconName = "logo" | "plus" | "arrow" | "folder" | "file" | "chevron" | "close" | "refresh" | "trash" | "edit" | "save" | "stop" | "power" | "logout" | "code" | "check" | "terminal" | "alert" | "menu" | "message" | "plug";
const paths: Record<IconName, React.ReactNode> = {
    logo: <><path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z"/><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5v3"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    folder: <path d="M3 7V5h6l2 3h10v12H3V7Z"/>, file: <><path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v5h4M9 12h6M9 16h6"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M19 8a8 8 0 0 0-14-2M5 16a8 8 0 0 0 14 2"/></>,
    trash: <><path d="M3 6h18M5 6l1 15h12l1-15M9 6V3h6v3M10 10v7M14 10v7"/></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/></>,
    save: <><path d="M4 3h13l4 4v14H3V3h1ZM7 3v6h10V3M7 21v-8h10v8"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1"/>,
    power: <><path d="M12 2v10M6.3 5.8a9 9 0 1 0 11.4 0"/></>,
    logout: <><path d="M10 4H4v16h6M8 12h13m-4-4 4 4-4 4"/></>,
    code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>,
    check: <path d="m5 12 4 4L19 6"/>, terminal: <><path d="m4 5 6 6-6 6M12 18h8"/></>,
    alert: <><path d="m12 3 10 18H2L12 3ZM12 9v5"/><path d="M12 17h.01"/></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    message: <path d="M3 3h18v14H9l-6 4V3Z"/>,
    plug: <><path d="M8 2v6m8-6v6M5 8h14v3a7 7 0 0 1-14 0V8ZM12 18v4"/></>,
};
export function Icon({ name, size = 18, className = "" }: {
    name: IconName;
    size?: number;
    className?: string;
}) {
    return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
export function Brand() {
    return <Link href="/workspaces" className="brand"><span className="brand-mark"><Icon name="logo" size={24}/></span><span>cloud<span className="brand-light">work</span><span className="brand-dot">.</span></span></Link>;
}
export function Header({ user, children }: {
    user: User;
    children?: React.ReactNode;
}) {
    const router = useRouter();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    async function logout() {
        setBusy(true);
        setError("");
        try {
            await api("/api/auth/sign-out", { method: "POST", body: "{}" });
            router.replace("/login");
        }
        catch (err) {
            setError(errorMessage(err));
            setBusy(false);
        }
    }
    return <><header className="app-header"><Brand /><div className="header-center">{children}</div><div className="account"><Link className="icon-button" href="/settings/mcp" aria-label="MCP connection settings" title="MCP connections"><Icon name="plug"/></Link><span className="account-email">{user.email}</span><span className="avatar" title={user.name || user.email}>{(user.name || user.email).charAt(0).toUpperCase()}</span><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={logout} disabled={busy}><Icon name="logout"/></button></div></header>{error && <ErrorBanner message={error} onDismiss={() => setError("")}/>}</>;
}
export function ErrorBanner({ message, onDismiss, onRetry }: {
    message: string;
    onDismiss?: () => void;
    onRetry?: () => void;
}) {
    return <div className="error-banner" role="alert"><Icon name="alert" size={17}/><span>{message}</span>{onRetry && <button className="text-button" onClick={onRetry}>Retry</button>}{onDismiss && <button className="icon-button" aria-label="Dismiss error" onClick={onDismiss}><Icon name="close" size={16}/></button>}</div>;
}
export function LoadingScreen({ error, retry }: {
    error?: string;
    retry?: () => void;
}) {
    return <main className="loading-screen"><Brand />{error ? <ErrorBanner message={error} onRetry={retry}/> : <div className="loading-label"><span className="spinner"/>Opening your workspace…</div>}</main>;
}
export function Modal({ title, description, children, onClose, className = "" }: {
    title: string;
    description?: string;
    children: React.ReactNode;
    onClose: () => void;
    className?: string;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const descriptionId = useId();
    useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
    return <dialog ref={ref} className={`modal ${className}`} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current)
        onClose(); }}><div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="close"/></button></div>{description && <p id={descriptionId} className="muted modal-description">{description}</p>}{children}</dialog>;
}
export function RuntimeControl({ runtime, onChange, disabled = false }: {
    runtime: Runtime | null;
    onChange: (runtime: Runtime) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const status = runtime?.status || "STARTING";
    async function action(value: "start" | "stop" | "remove") {
        if (value === "remove" && !window.confirm("Remove your runtime container? Your workspace files and session data are kept. It will be recreated when you resume work."))
            return;
        setBusy(true);
        setError("");
        try {
            const data = await api<{
                runtime: Runtime;
            }>("/api/runtime", { method: "POST", body: JSON.stringify({ action: value }) });
            onChange(data.runtime);
            setOpen(false);
        }
        catch (err) {
            setError(errorMessage(err));
        }
        finally {
            setBusy(false);
        }
    }
    return <div className="runtime-control"><button className="runtime-badge" aria-expanded={open} onClick={() => setOpen(!open)}><span className={`status-dot status-${status.toLowerCase()}`}/><span>{busy ? "Updating…" : !runtime ? "Checking…" : status.charAt(0) + status.slice(1).toLowerCase()}</span><Icon name="chevron" size={12} className={open ? "rotated" : "down"}/></button>{open && <div className="runtime-popover"><div className="eyebrow">YOUR RUNTIME</div><p>Shared by your workspaces. Files persist when the runtime stops or is removed.</p>{error && <ErrorBanner message={error}/>}<button disabled={busy || disabled} onClick={() => action("start")}><Icon name="power" size={16}/>Start / reconnect</button><button disabled={busy || disabled || !["RUNNING", "IDLE"].includes(status)} onClick={() => action("stop")}><Icon name="stop" size={16}/>Stop runtime</button><button disabled={busy || disabled || status === "REMOVED"} onClick={() => action("remove")}><Icon name="trash" size={16}/>Remove container</button>{disabled && <p className="small muted">Stop the active agent run first.</p>}</div>}</div>;
}
