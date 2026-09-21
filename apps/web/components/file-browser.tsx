"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { FILE_TRANSFER_LIMITS } from "@cloud-work/protocol";
import { api, errorMessage, type FileEntry } from "./client";
import { ErrorBanner, Icon, Modal } from "./ui";
import { FileUploads } from "./file-upload";
import { FilePreview } from "./file-preview";
import { downloadUrl, isTextFile } from "./file-transfer";
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
    const [editing, setEditing] = useState(false);
    const [preview, setPreview] = useState<FileEntry | null>(null);
    const [uploading, setUploading] = useState(false);
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
            if (!link || link.hasAttribute("download") || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
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
        if (entry.type === "directory") {
            setSelected(entry);
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
        setSelected(entry);
        setError("");
        if (!isTextFile(entry.path) || entry.size > FILE_TRANSFER_LIMITS.maxTextBytes) {
            setEditor(null);
            setPreview(entry);
            setEditing(false);
            return;
        }
        setLoadingFile(true);
        setError("");
        setSaved(false);
        try {
            const data = await api<{
                content: string;
            }>(`${endpoint}/content?path=${encodeURIComponent(entry.path)}`);
            setPreview(null);
            setEditing(false);
            setEditor({ path: entry.path, original: data.content, content: data.content });
        }
        catch (err) {
            // A text extension may still contain binary or non-UTF-8 data.
            setEditor(null);
            setPreview(entry);
            if (!/binary|utf.?8|text file/i.test(errorMessage(err))) setError(errorMessage(err));
        }
        finally {
            setLoadingFile(false);
        }
    }
    async function save() {
        if (!editor || saving || !dirty)
            return;
        if (new TextEncoder().encode(editor.content).byteLength > FILE_TRANSFER_LIMITS.maxTextBytes) {
            setError("Text files must be no larger than 10 MiB to save in the editor.");
            return;
        }
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
                setPreview(current => current && (current.path === action.path || current.path.startsWith(`${action.path}/`)) ? { ...current, path: path + current.path.slice(action.path.length), name: current.path === action.path ? path.split("/").at(-1)! : current.name } : current);
                setSelected(null);
            }
            setAction(null);
            setTree({});
            setExpanded(new Set([""]));
            await load("");
            if (action.kind === "file") {
                setPreview(null);
                setEditing(true);
                setEditor({ path, original: "", content: "" });
            }
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
            if (preview && (preview.path === selected.path || preview.path.startsWith(`${selected.path}/`))) setPreview(null);
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
        return tree[path]?.map(entry => <div key={entry.path}><button disabled={loadingFile || uploading} className={`file-row ${selected?.path === entry.path ? "selected" : ""}`} style={{ paddingLeft: 15 + level * 15 }} onClick={() => void openEntry(entry)} title={entry.path}><span className="file-chevron">{entry.type === "directory" && <Icon name="chevron" size={12} className={expanded.has(entry.path) ? "down" : ""}/>}</span><Icon name={entry.type === "directory" ? "folder" : "file"} size={16}/><span>{entry.name}</span>{entry.type === "symlink" && <span className="muted">↗</span>}</button>{entry.type === "directory" && expanded.has(entry.path) && <div role="group">{loadingPaths.has(entry.path) ? <div className="tree-loading" style={{ paddingLeft: 35 + level * 15 }}>Loading…</div> : tree[entry.path]?.length === 0 ? <div className="tree-loading" style={{ paddingLeft: 35 + level * 15 }}>Empty folder</div> : renderDirectory(entry.path, level + 1)}</div>}</div>);
    }
    return <>
        <aside ref={drawerRef} inert={narrow && !open} aria-hidden={narrow && !open ? true : undefined} className={`files-panel ${open ? "mobile-open" : ""}`}>
            <div className="panel-heading"><div><Icon name="folder" size={17}/><h2>Files</h2></div><div className="file-toolbar">
                <a className="icon-button" download href={downloadUrl(endpoint, "", true)} title="Download workspace as ZIP" aria-label="Download workspace as ZIP"><Icon name="download" size={15}/></a>
                <button className="icon-button" title="Refresh files" aria-label="Refresh files" onClick={() => { setError(""); for (const path of expanded) void load(path); }}><Icon name="refresh" size={15}/></button>
                <button className="icon-button mobile-only" aria-label="Close files" onClick={closeDrawer}><Icon name="close" size={17}/></button>
            </div></div>
            <div className="file-actions"><button disabled={uploading || mutating} onClick={() => { if (discardAllowed()) beginAction("file"); }} title="New file"><Icon name="file" size={15}/>New file</button><button disabled={uploading || mutating} onClick={() => beginAction("directory")} title="New folder"><Icon name="plus" size={15}/>Folder</button></div>
            {error && <ErrorBanner message={error} onDismiss={() => setError("")}/>}
            <FileUploads key={endpoint} endpoint={endpoint} disabled={saving || mutating || loadingFile} destination={selected?.type === "directory" ? selected.path : ""} onRoot={() => setSelected(null)} onBusy={setUploading} beforeUpload={() => {
                if (saving || mutating || loadingFile) return false;
                if (!discardAllowed()) return false;
                setEditor(null); setPreview(null); return true;
            }} onChanged={() => { for (const path of expanded) void load(path); }}>
                <div className="file-tree" aria-label="Workspace files">{loadingPaths.has("") && !tree[""] ? <div className="tree-loading">Loading files…</div> : tree[""]?.length === 0 ? <div className="files-empty"><Icon name="folder" size={26}/><p>No files yet</p><span>Drop files or folders here,<br/>or ask your agent to start building.</span></div> : renderDirectory("", 0)}</div>
            </FileUploads>
            {selected && <div className="selected-file-actions"><span title={selected.path}>{selected.name}</span>
                {selected.type !== "symlink" && <a className="icon-button" download href={downloadUrl(endpoint, selected.path, selected.type === "directory")} aria-label={`Download ${selected.name}${selected.type === "directory" ? " as ZIP" : ""}`} title={selected.type === "directory" ? "Download folder as ZIP" : "Download file"}><Icon name="download" size={15}/></a>}
                <button className="icon-button" aria-label={`Rename ${selected.name}`} title="Rename" disabled={mutating || uploading} onClick={() => beginAction("rename")}><Icon name="edit" size={15}/></button>
                <button className="icon-button danger" aria-label={`Delete ${selected.name}`} title="Delete" disabled={mutating || uploading} onClick={() => void remove()}><Icon name="trash" size={15}/></button>
            </div>}
            <div className="files-footer"><Icon name="code" size={14}/><span>Persistent workspace files</span></div>
        </aside>
        {editor && <section className="editor-panel" aria-label={editing ? "File editor" : "Text preview"}>
            <div className="editor-heading"><div><Icon name="file" size={16}/><span title={editor.path}>{editor.path}</span>{dirty && <span className="unsaved-dot" title="Unsaved changes"/>}</div><button className="icon-button" disabled={saving} aria-label="Close file" onClick={() => { if (discardAllowed()) setEditor(null); }}><Icon name="close" size={17}/></button></div>
            <div className="editor-meta"><span>UTF-8 · {editor.content.split("\n").length} lines · {editing ? "Editing" : "Read only"}</span><div className="file-editor-actions">
                <a className="icon-button" download href={downloadUrl(endpoint, editor.path)} aria-label="Download current file" title="Download saved file"><Icon name="download" size={14}/></a>
                {editing ? <><button className="button button-small button-secondary" disabled={saving} onClick={() => { if (discardAllowed()) { setEditor({ ...editor, content: editor.original }); setEditing(false); } }}>Preview</button><button className="button button-small button-secondary" onClick={() => void save()} disabled={!dirty || saving}><Icon name={saved && !dirty ? "check" : "save"} size={14}/>{saving ? "Saving…" : saved && !dirty ? "Saved" : "Save"}</button></> : <button className="button button-small button-secondary" onClick={() => setEditing(true)}><Icon name="edit" size={14}/>Edit</button>}
            </div></div>
            <textarea className="code-editor" aria-label={`${editing ? "Edit" : "Preview"} ${editor.path}`} readOnly={!editing} spellCheck={false} value={editor.content} onChange={event => { setEditor({ ...editor, content: event.target.value }); setSaved(false); }}/>
            <div className="editor-footer"><span>{dirty ? "Unsaved changes" : editing ? "All changes saved" : "Read-only preview"}</span><span>{editing ? "⌘ / Ctrl S to save" : "Choose Edit to make changes"}</span></div>
        </section>}
        {preview && <FilePreview key={preview.path} entry={preview} endpoint={endpoint} onClose={() => setPreview(null)}/>}
        {action && <Modal title={action.kind === "file" ? "New file" : action.kind === "directory" ? "New folder" : "Rename entry"} description="Use a path relative to this workspace." onClose={() => { if (!mutating) setAction(null); }}><form onSubmit={performAction}>
            <label>{action.kind === "rename" ? "New path" : "Path"}<input autoFocus required value={actionValue} onChange={event => setActionValue(event.target.value)} placeholder={action.kind === "directory" ? "src/components" : "src/index.ts"}/></label>
            {actionError && <ErrorBanner message={actionError}/>}
            <div className="modal-actions"><button className="button button-secondary" type="button" disabled={mutating} onClick={() => setAction(null)}>Cancel</button><button className="button button-primary" disabled={mutating}>{mutating ? "Saving…" : action.kind === "rename" ? "Rename" : "Create"}</button></div>
        </form></Modal>}
    </>;
}
