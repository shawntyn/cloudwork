"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type FileEntry } from "./client";
import { ErrorBanner, Icon, Modal } from "./ui";
type EditFile = {
    path: string;
    original: string;
    content: string;
};
type FileAction = {
    kind: "file" | "directory" | "rename";
    path: string;
};
export function FileBrowser({ workspaceId, revision, open, onClose }: {
    workspaceId: string;
    revision: number;
    open: boolean;
    onClose: () => void;
}) {
    const endpoint = `/api/workspaces/${workspaceId}/files`;
    const [tree, setTree] = useState<Record<string, FileEntry[]>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
    const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
    const [error, setError] = useState("");
    const [editor, setEditor] = useState<EditFile | null>(null);
    const [loadingFile, setLoadingFile] = useState(false);
    const [selected, setSelected] = useState<FileEntry | null>(null);
    const [action, setAction] = useState<FileAction | null>(null);
    const [actionValue, setActionValue] = useState("");
    const [actionError, setActionError] = useState("");
    const [saving, setSaving] = useState(false);
    const [mutating, setMutating] = useState(false);
    const [saved, setSaved] = useState(false);
    const [narrow, setNarrow] = useState(false);
    const drawerRef = useRef<HTMLElement>(null);
    const drawerTriggerRef = useRef<HTMLElement | null>(null);
    const saveRef = useRef<() => void>(() => { });
    const dirty = !!editor && editor.content !== editor.original;
    useEffect(() => {
        const media = window.matchMedia("(max-width: 760px)");
        const sync = () => setNarrow(media.matches);
        sync();
        media.addEventListener("change", sync);
        return () => media.removeEventListener("change", sync);
    }, []);
    useEffect(() => {
        if (!narrow || !open) return;
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && !drawerRef.current?.contains(activeElement)) {
            drawerTriggerRef.current = activeElement;
            drawerRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Close files"]')?.focus();
        }
    }, [narrow, open]);
    function closeDrawer() {
        if (narrow) drawerTriggerRef.current?.focus();
        onClose();
    }
    const load = useCallback(async (path: string) => {
        setLoadingPaths(paths => new Set([...paths, path]));
        try {
            const data = await api<{
                entries: FileEntry[];
            }>(`${endpoint}?path=${encodeURIComponent(path)}`);
            setTree(current => ({ ...current, [path]: data.entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name)) }));
        }
        catch (err) {
            setError(errorMessage(err));
        }
        finally {
            setLoadingPaths(paths => { const next = new Set(paths); next.delete(path); return next; });
        }
    }, [endpoint]);
    useEffect(() => { void load(""); }, [load, revision]);
    useEffect(() => {
        if (!dirty)
            return;
        function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); }
        function beforeNavigation(event: MouseEvent) {
            const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
            if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                return;
            if (link.getAttribute("href") !== window.location.pathname && !window.confirm("Discard unsaved changes to this file?")) {
                event.preventDefault();
                event.stopPropagation();
            }
        }
        window.addEventListener("beforeunload", beforeUnload);
        document.addEventListener("click", beforeNavigation, true);
        return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", beforeNavigation, true); };
    }, [dirty]);
    useEffect(() => {
        function saveKey(event: KeyboardEvent) { if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            saveRef.current();
        } }
        window.addEventListener("keydown", saveKey);
        return () => window.removeEventListener("keydown", saveKey);
    }, []);
    function discardAllowed() { return !dirty || window.confirm("Discard unsaved changes to this file?"); }
    async function openEntry(entry: FileEntry) {
        setSelected(entry);
        if (entry.type === "directory") {
            const opening = !expanded.has(entry.path);
            setExpanded(current => { const next = new Set(current); if (opening)
                next.add(entry.path);
            else
                next.delete(entry.path); return next; });
            if (opening)
                await load(entry.path);
            return;
        }
        if (entry.type === "symlink") {
            setError("Symbolic links cannot be opened from the file browser.");
            return;
        }
        if (entry.path === editor?.path || !discardAllowed())
            return;
        setLoadingFile(true);
        setError("");
        setSaved(false);
        try {
            const data = await api<{
                content: string;
            }>(`${endpoint}/content?path=${encodeURIComponent(entry.path)}`);
            setEditor({ path: entry.path, original: data.content, content: data.content });
        }
        catch (err) {
            setError(errorMessage(err));
        }
        finally {
            setLoadingFile(false);
        }
    }
    async function save() {
        if (!editor || saving || !dirty)
            return;
        setSaving(true);
        setError("");
        const current = editor;
        try {
            await api(`${endpoint}/content`, { method: "PUT", body: JSON.stringify({ path: current.path, content: current.content }) });
            setEditor(value => value?.path === current.path ? { ...value, original: current.content } : value);
            setSaved(true);
            await load(current.path.split("/").slice(0, -1).join("/"));
        }
        catch (err) {
            setError(errorMessage(err));
        }
        finally {
            setSaving(false);
        }
    }
    saveRef.current = () => { void save(); };
    function beginAction(kind: FileAction["kind"]) {
        const path = kind === "rename" ? selected?.path || "" : selected?.type === "directory" ? `${selected.path}/` : "";
        setAction({ kind, path });
        setActionValue(path);
        setActionError("");
    }
    async function performAction(event: React.FormEvent) {
        event.preventDefault();
        if (!action)
            return;
        const path = actionValue.trim();
        if (!path || path.startsWith("/") || path.split("/").some(part => !part || part === ".." || part === ".")) {
            setActionError("Use a relative path, such as src/index.ts. Empty segments, . and .. are not allowed.");
            return;
        }
        setMutating(true);
        setActionError("");
        try {
            if (action.kind === "file") {
                const parent = path.split("/").slice(0, -1).join("/");
                const existing = await api<{
                    entries: FileEntry[];
                }>(`${endpoint}?path=${encodeURIComponent(parent)}`);
                if (existing.entries.some(entry => entry.name === path.split("/").at(-1)))
                    throw new Error("An entry already exists at this path. Choose another name.");
                await api(`${endpoint}/content`, { method: "PUT", body: JSON.stringify({ path, content: "" }) });
            }
            else
                await api(endpoint, { method: "POST", body: JSON.stringify(action.kind === "directory" ? { operation: "mkdir", path } : { operation: "rename", path: action.path, to: path }) });
            if (action.kind === "rename") {
                setEditor(current => current && (current.path === action.path || current.path.startsWith(`${action.path}/`)) ? { ...current, path: path + current.path.slice(action.path.length) } : current);
                setSelected(null);
            }
            setAction(null);
            setTree({});
            setExpanded(new Set([""]));
            await load("");
            if (action.kind === "file")
                setEditor({ path, original: "", content: "" });
        }
        catch (err) {
            setActionError(errorMessage(err));
        }
        finally {
            setMutating(false);
        }
    }
    async function remove() {
        if (!selected || !window.confirm(`Permanently delete “${selected.path}”${selected.type === "directory" ? " and everything inside it" : ""}?`))
            return;
        if (editor && (editor.path === selected.path || editor.path.startsWith(`${selected.path}/`)) && !discardAllowed())
            return;
        setMutating(true);
        setError("");
        try {
            await api(`${endpoint}?path=${encodeURIComponent(selected.path)}`, { method: "DELETE" });
            if (editor && (editor.path === selected.path || editor.path.startsWith(`${selected.path}/`)))
                setEditor(null);
            setSelected(null);
            setTree({});
            setExpanded(new Set([""]));
            await load("");
        }
        catch (err) {
            setError(errorMessage(err));
        }
        finally {
            setMutating(false);
        }
    }
    function renderDirectory(path: string, level: number): React.ReactNode {
        return tree[path]?.map(entry => <div key={entry.path}><button disabled={loadingFile} className={`file-row ${selected?.path === entry.path ? "selected" : ""}`} style={{ paddingLeft: 15 + level * 15 }} onClick={() => void openEntry(entry)} title={entry.path}><span className="file-chevron">{entry.type === "directory" && <Icon name="chevron" size={12} className={expanded.has(entry.path) ? "down" : ""}/>}</span><Icon name={entry.type === "directory" ? "folder" : "file"} size={16}/><span>{entry.name}</span>{entry.type === "symlink" && <span className="muted">↗</span>}</button>{entry.type === "directory" && expanded.has(entry.path) && <div role="group">{loadingPaths.has(entry.path) ? <div className="tree-loading" style={{ paddingLeft: 35 + level * 15 }}>Loading…</div> : tree[entry.path]?.length === 0 ? <div className="tree-loading" style={{ paddingLeft: 35 + level * 15 }}>Empty folder</div> : renderDirectory(entry.path, level + 1)}</div>}</div>);
    }
    return <><aside ref={drawerRef} inert={narrow && !open} aria-hidden={narrow && !open ? true : undefined} className={`files-panel ${open ? "mobile-open" : ""}`}><div className="panel-heading"><div><Icon name="folder" size={17}/><h2>Files</h2></div><div className="file-toolbar"><button className="icon-button" title="Refresh files" aria-label="Refresh files" onClick={() => { setError(""); for (const path of expanded)
        void load(path); }}><Icon name="refresh" size={15}/></button><button className="icon-button mobile-only" aria-label="Close files" onClick={closeDrawer}><Icon name="close" size={17}/></button></div></div><div className="file-actions"><button onClick={() => { if (discardAllowed())
        beginAction("file"); }} title="New file"><Icon name="file" size={15}/>New file</button><button onClick={() => beginAction("directory")} title="New folder"><Icon name="plus" size={15}/>Folder</button></div>{error && <ErrorBanner message={error} onDismiss={() => setError("")}/>}<div className="file-tree" aria-label="Workspace files">{loadingPaths.has("") && !tree[""] ? <div className="tree-loading">Loading files…</div> : tree[""]?.length === 0 ? <div className="files-empty"><Icon name="folder" size={26}/><p>No files yet</p><span>Create a file or ask your agent<br />to start building.</span></div> : renderDirectory("", 0)}</div>{selected && <div className="selected-file-actions"><span title={selected.path}>{selected.name}</span><button className="icon-button" aria-label={`Rename ${selected.name}`} title="Rename" disabled={mutating} onClick={() => beginAction("rename")}><Icon name="edit" size={15}/></button><button className="icon-button danger" aria-label={`Delete ${selected.name}`} title="Delete" disabled={mutating} onClick={() => void remove()}><Icon name="trash" size={15}/></button></div>}<div className="files-footer"><Icon name="code" size={14}/><span>Persistent workspace files</span></div></aside>{editor && <section className="editor-panel" aria-label="File editor"><div className="editor-heading"><div><Icon name="file" size={16}/><span title={editor.path}>{editor.path}</span>{dirty && <span className="unsaved-dot" title="Unsaved changes"/>}</div><button className="icon-button" disabled={saving} aria-label="Close file" onClick={() => { if (discardAllowed())
        setEditor(null); }}><Icon name="close" size={17}/></button></div><div className="editor-meta"><span>UTF-8 · {editor.content.split("\n").length} lines</span><button className="button button-small button-secondary" onClick={() => void save()} disabled={!dirty || saving}><Icon name={saved && !dirty ? "check" : "save"} size={14}/>{saving ? "Saving…" : saved && !dirty ? "Saved" : "Save"}</button></div><textarea className="code-editor" aria-label={`Edit ${editor.path}`} spellCheck={false} value={editor.content} onChange={event => { setEditor({ ...editor, content: event.target.value }); setSaved(false); }}/><div className="editor-footer"><span>{dirty ? "Unsaved changes" : "All changes saved"}</span><span>⌘ / Ctrl S to save</span></div></section>}{action && <Modal title={action.kind === "file" ? "New file" : action.kind === "directory" ? "New folder" : "Rename entry"} description="Use a path relative to this workspace." onClose={() => { if (!mutating)
        setAction(null); }}><form onSubmit={performAction}><label>{action.kind === "rename" ? "New path" : "Path"}<input autoFocus required value={actionValue} onChange={e => setActionValue(e.target.value)} placeholder={action.kind === "directory" ? "src/components" : "src/index.ts"}/></label>{actionError && <ErrorBanner message={actionError}/>}<div className="modal-actions"><button className="button button-secondary" type="button" disabled={mutating} onClick={() => setAction(null)}>Cancel</button><button className="button button-primary" disabled={mutating}>{mutating ? "Saving…" : action.kind === "rename" ? "Rename" : "Create"}</button></div></form></Modal>}</>;
}
