"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { FILE_TRANSFER_LIMITS } from "@cloud-work/protocol";
import { api, ApiClientError, errorMessage, type FileEntry } from "./client";
import { ErrorBanner, Icon, Modal } from "./ui";
import { FileUploads } from "./file-upload";
import { FilePreview } from "./file-preview";
import { DOCUMENT_PREVIEW_LIMITS, downloadSmallFile, downloadUrl, isMarkdownFile, isSafeImageFile, isTextFile, previewFormat } from "./file-transfer";
import { useLocale } from "./locale";
import { CodeViewer, RichContent, languageFromFilename } from "./rich-content";
import { clientUuid } from "./client-uuid";
type EditFile = {
    path: string;
    original: string;
    content: string;
    version: string | null;
};
type RemoteConflict = { content: string; version: string };
type FileAction = {
    kind: "file" | "directory" | "rename";
    path: string;
};
export function FileBrowser({ workspaceId, revision, open, onClose, closeRequestRef }: {
    workspaceId: string;
    revision: number;
    open: boolean;
    onClose: () => void;
    closeRequestRef?: React.RefObject<(() => void) | null>;
}) {
    const endpoint = `/api/workspaces/${workspaceId}/files`;
    const { tr, locale } = useLocale();
    const [tree, setTree] = useState<Record<string, FileEntry[]>>({});
    const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
    const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
    const [treeErrors, setTreeErrors] = useState<Record<string, string>>({});
    const [query, setQuery] = useState("");
    const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
    const [searchBusy, setSearchBusy] = useState(false);
    const [searchError, setSearchError] = useState("");
    const [searchTruncated, setSearchTruncated] = useState(false);
    const [searchRetry, setSearchRetry] = useState(0);
    const [localRevision, setLocalRevision] = useState(0);
    const [error, setError] = useState("");
    const [editor, setEditor] = useState<EditFile | null>(null);
    const [conflict, setConflict] = useState<RemoteConflict | null>(null);
    const [fileLoadError, setFileLoadError] = useState("");
    const [showSource, setShowSource] = useState(false);
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
    const [activeTab, setActiveTab] = useState<"files" | "preview">("files");
    const drawerRef = useRef<HTMLElement>(null);
    const drawerTriggerRef = useRef<HTMLElement | null>(null);
    const restoreFocusRef = useRef(false);
    const previousTabRef = useRef(activeTab);
    const closeDrawerRef = useRef<() => void>(() => {});
    const saveRef = useRef<() => void>(() => { });
    const expandedRef = useRef(expanded);
    expandedRef.current = expanded;
    const editorRef = useRef(editor);
    editorRef.current = editor;
    const previewRef = useRef(preview);
    previewRef.current = preview;
    const historyGuard = useRef<string | null>(null);
    const allowHistoryExit = useRef(false);
    const dirty = !!editor && editor.content !== editor.original;
    useEffect(() => {
        if (dirty && !historyGuard.current) {
            const marker = clientUuid();
            historyGuard.current = marker;
            window.history.pushState({ ...window.history.state, cloudworkFileDraft: marker }, "", window.location.href);
        } else if (!dirty && historyGuard.current) {
            const marker = historyGuard.current;
            historyGuard.current = null;
            if (window.history.state?.cloudworkFileDraft === marker) window.history.back();
        }
    }, [dirty]);
    useEffect(() => {
        if (!dirty) return;
        const onPopState = () => {
            if (allowHistoryExit.current) { allowHistoryExit.current = false; return; }
            if (window.confirm(tr("放弃此文件尚未保存的更改？", "Discard unsaved changes to this file?"))) {
                allowHistoryExit.current = true;
                historyGuard.current = null;
                window.history.back();
            } else {
                window.history.pushState({ ...window.history.state, cloudworkFileDraft: historyGuard.current }, "", window.location.href);
            }
        };
        window.addEventListener("popstate", onPopState);
        return () => window.removeEventListener("popstate", onPopState);
    }, [dirty, tr]);
    useEffect(() => {
        const media = window.matchMedia("(max-width: 1100px)");
        const sync = () => setNarrow(media.matches);
        sync();
        media.addEventListener("change", sync);
        return () => media.removeEventListener("change", sync);
    }, []);
    useEffect(() => {
        if (!open) return;
        const activeElement = document.activeElement;
        if (!drawerRef.current?.contains(activeElement)) {
            drawerTriggerRef.current = activeElement instanceof HTMLElement && activeElement !== document.body
                ? activeElement : document.querySelector<HTMLButtonElement>(".cw-files-open");
            if (narrow) drawerRef.current?.querySelector<HTMLButtonElement>('[data-close-files]')?.focus();
        }
    }, [narrow, open]);
    useEffect(() => {
        if (open || !restoreFocusRef.current) return;
        restoreFocusRef.current = false;
        const frame = window.requestAnimationFrame(() => {
            const trigger = drawerTriggerRef.current?.isConnected ? drawerTriggerRef.current : document.querySelector<HTMLButtonElement>(".cw-files-open");
            if (trigger && !trigger.closest("[inert]")) trigger.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [open]);
    useEffect(() => {
        if (previousTabRef.current === activeTab) return;
        previousTabRef.current = activeTab;
        if (open) drawerRef.current?.querySelector<HTMLButtonElement>(`[data-file-tab="${activeTab}"]`)?.focus();
    }, [activeTab, open]);
    useEffect(() => {
        if (!narrow || !open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (document.querySelector("dialog[open]")) return;
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeDrawerRef.current();
                return;
            }
            if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
            const drawer = drawerRef.current;
            if (!drawer) return;
            const focusable = Array.from(drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'))
                .filter(element => element.tabIndex >= 0 && !element.closest("[hidden], [inert]") && element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== "hidden");
            const first = focusable[0];
            const last = focusable.at(-1);
            if (!first || !last) {
                event.preventDefault();
                drawer.focus();
            } else if (!drawer.contains(document.activeElement)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
    }, [narrow, open]);
    function closeDrawer() {
        if (!discardAllowed()) return;
        restoreFocusRef.current = true;
        onClose();
    }
    closeDrawerRef.current = closeDrawer;
    if (closeRequestRef) closeRequestRef.current = closeDrawer;
    const load = useCallback(async (path: string) => {
        setLoadingPaths(paths => new Set([...paths, path]));
        try {
            const data = await api<{
                entries: FileEntry[];
            }>(`${endpoint}?path=${encodeURIComponent(path)}`);
            setTree(current => ({ ...current, [path]: data.entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name, locale)) }));
            setTreeErrors(current => { const next = { ...current }; delete next[path]; return next; });
            const active = previewRef.current;
            if (active && active.path.split("/").slice(0, -1).join("/") === path) {
                const latest = data.entries.find(item => item.path === active.path);
                if (latest) setPreview(current => current?.path === active.path ? latest : current);
                else setFileLoadError(tr("此文件已被移走或删除。", "This file was moved or deleted."));
            }
        }
        catch (err) {
            setTreeErrors(current => ({ ...current, [path]: errorMessage(err) }));
        }
        finally {
            setLoadingPaths(paths => { const next = new Set(paths); next.delete(path); return next; });
        }
    }, [endpoint, locale, tr]);
    useEffect(() => {
        if (!open) return;
        for (const path of expandedRef.current) void load(path);
        const current = editorRef.current;
        if (!current || !current.version) return;
        void api<{ content: string; version: string }>(`${endpoint}/content?path=${encodeURIComponent(current.path)}`).then(remote => {
            const latest = editorRef.current;
            if (!latest || latest.path !== current.path) return;
            setFileLoadError("");
            if (latest.version === remote.version) return;
            if (latest.content !== latest.original) { setConflict(remote); return; }
            setConflict(null);
            setEditor(existing => existing?.path === current.path && existing.content === existing.original ? { ...existing, original: remote.content, content: remote.content, version: remote.version } : existing);
        }).catch(cause => {
            if (editorRef.current?.path === current.path) setFileLoadError(errorMessage(cause));
        });
    }, [load, revision, localRevision, open, endpoint]);
    useEffect(() => {
        if (!open || !query.trim()) { setSearchResults([]); setSearchBusy(false); setSearchError(""); return; }
        if (query.length > 100) { setSearchError(tr("最多输入 100 个字符。", "Enter up to 100 characters.")); return; }
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            setSearchBusy(true); setSearchError("");
            void api<{ entries: FileEntry[]; truncated: boolean }>(`${endpoint}/search?query=${encodeURIComponent(query.trim())}`, { signal: controller.signal }).then(data => {
                if (!controller.signal.aborted) { setSearchResults(data.entries); setSearchTruncated(data.truncated); }
            }).catch(cause => { if (!controller.signal.aborted) setSearchError(errorMessage(cause)); })
                .finally(() => { if (!controller.signal.aborted) setSearchBusy(false); });
        }, 250);
        return () => { window.clearTimeout(timer); controller.abort(); };
    }, [endpoint, open, query, revision, localRevision, searchRetry, tr]);
    useEffect(() => {
        if (!dirty)
            return;
        function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); }
        function beforeNavigation(event: MouseEvent) {
            const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
            if (!link || link.hasAttribute("download") || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                return;
            if (link.getAttribute("href") !== window.location.pathname && !window.confirm(tr("放弃此文件尚未保存的更改？", "Discard unsaved changes to this file?"))) {
                event.preventDefault();
                event.stopPropagation();
            }
        }
        window.addEventListener("beforeunload", beforeUnload);
        document.addEventListener("click", beforeNavigation, true);
        return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", beforeNavigation, true); };
    }, [dirty, tr]);
    useEffect(() => {
        function saveKey(event: KeyboardEvent) { if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            saveRef.current();
        } }
        window.addEventListener("keydown", saveKey);
        return () => window.removeEventListener("keydown", saveKey);
    }, []);
    function discardAllowed() { return !dirty || window.confirm(tr("放弃此文件尚未保存的更改？", "Discard unsaved changes to this file?")); }
    async function openEntry(entry: FileEntry, force = false) {
        if (entry.type === "directory") {
            setSelected(entry);
            const opening = force || !expanded.has(entry.path);
            const ancestors = entry.path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"));
            setExpanded(current => { const next = new Set(current); if (opening) for (const part of ancestors) next.add(part);
            else next.delete(entry.path); return next; });
            if (opening) await Promise.all(ancestors.filter(path => !tree[path]).map(load));
            return;
        }
        if (entry.type === "symlink") {
            setError(tr("无法在文件浏览器中打开符号链接。", "Symbolic links cannot be opened from the file browser."));
            return;
        }
        if (!force && (entry.path === editor?.path || entry.path === preview?.path)) {
            setActiveTab("preview");
            return;
        }
        if (!discardAllowed())
            return;
        setSelected(entry);
        setError("");
        setFileLoadError("");
        setConflict(null);
        setShowSource(false);
        if (!isTextFile(entry.path) || entry.size > FILE_TRANSFER_LIMITS.maxTextBytes) {
            setEditor(null);
            setPreview(entry);
            setEditing(false);
            setActiveTab("preview");
            return;
        }
        setLoadingFile(true);
        setError("");
        setSaved(false);
        try {
            const data = await api<{
                content: string;
                version: string;
            }>(`${endpoint}/content?path=${encodeURIComponent(entry.path)}`);
            setPreview(null);
            setEditing(false);
            setEditor({ path: entry.path, original: data.content, content: data.content, version: data.version });
            setActiveTab("preview");
        }
        catch (err) {
            // A text extension may still contain binary or non-UTF-8 data.
            setEditor(null);
            setPreview(entry);
            setFileLoadError(errorMessage(err));
            setActiveTab("preview");
        }
        finally {
            setLoadingFile(false);
        }
    }
    async function save() {
        if (!editor || saving || !dirty)
            return;
        if (conflict) { setFileLoadError(tr("文件已更新。请先处理版本冲突。", "The file changed. Resolve the version conflict before saving.")); return; }
        if (new TextEncoder().encode(editor.content).byteLength > FILE_TRANSFER_LIMITS.maxTextBytes) {
            setError(tr("文本文件超过 10 MiB，无法在编辑器中保存。", "Text files must be no larger than 10 MiB to save in the editor."));
            return;
        }
        setSaving(true);
        setFileLoadError("");
        const current = editor;
        try {
            const result = await api<{ version: string }>(`${endpoint}/content`, { method: "PUT", body: JSON.stringify({ path: current.path, content: current.content, ...(current.version ? { expectedVersion: current.version } : {}) }) });
            setEditor(value => value?.path === current.path ? { ...value, original: current.content, version: result.version } : value);
            setSaved(true);
            await load(current.path.split("/").slice(0, -1).join("/"));
        }
        catch (err) {
            if (err instanceof ApiClientError && err.status === 409) {
                try {
                    const remote = await api<RemoteConflict>(`${endpoint}/content?path=${encodeURIComponent(current.path)}`);
                    setConflict(remote);
                    setFileLoadError(tr("保存前文件已改变，请选择使用新版或保留草稿。", "The file changed before saving. Choose the latest version or keep your draft."));
                } catch (loadError) { setFileLoadError(errorMessage(loadError)); }
            } else setFileLoadError(errorMessage(err));
        }
        finally {
            setSaving(false);
        }
    }
    saveRef.current = () => { void save(); };
    function beginAction(kind: FileAction["kind"], entry: FileEntry | null = selected) {
        const path = kind === "rename" ? entry?.path || "" : entry?.type === "directory" ? entry.path : entry?.path.split("/").slice(0, -1).join("/") || "";
        setAction({ kind, path });
        setActionValue(kind === "rename" ? path.split("/").at(-1) || "" : "");
        setActionError("");
    }
    async function performAction(event: React.FormEvent) {
        event.preventDefault();
        if (!action)
            return;
        const name = actionValue.trim();
        if (!name || name === "." || name === ".." || /[/\\\x00-\x1f\x7f]/.test(name)) {
            setActionError(tr("请输入有效名称；名称不能包含斜杠、反斜杠或控制字符。", "Enter a valid name without slashes, backslashes, or control characters."));
            return;
        }
        const parent = action.kind === "rename" ? action.path.split("/").slice(0, -1).join("/") : action.path;
        const path = parent ? `${parent}/${name}` : name;
        setMutating(true);
        setActionError("");
        try {
            if (action.kind === "file") {
                const existing = await api<{
                    entries: FileEntry[];
                }>(`${endpoint}?path=${encodeURIComponent(parent)}`);
                if (existing.entries.some(entry => entry.name === path.split("/").at(-1)))
                    throw new Error(tr("此位置已有同名项目，请换一个名称。", "An entry already exists here. Choose another name."));
                const created = await api<{ version: string }>(`${endpoint}/content`, { method: "PUT", body: JSON.stringify({ path, content: "" }) });
                setEditor({ path, original: "", content: "", version: created.version });
            }
            else
                await api(endpoint, { method: "POST", body: JSON.stringify(action.kind === "directory" ? { operation: "mkdir", path } : { operation: "rename", path: action.path, to: path }) });
            if (action.kind === "rename") {
                setEditor(current => current && (current.path === action.path || current.path.startsWith(`${action.path}/`)) ? { ...current, path: path + current.path.slice(action.path.length) } : current);
                setPreview(current => current && (current.path === action.path || current.path.startsWith(`${action.path}/`)) ? { ...current, path: path + current.path.slice(action.path.length), name: current.path === action.path ? path.split("/").at(-1)! : current.name } : current);
                setSelected(null);
            }
            setAction(null);
            if (action.kind === "rename") {
                setTree({});
                setExpanded(new Set([""]));
                await load("");
            } else {
                await load(parent);
            }
            if (action.kind === "file") {
                setPreview(null);
                setEditing(true);
                setActiveTab("preview");
            }
        }
        catch (err) {
            setActionError(errorMessage(err));
        }
        finally {
            setMutating(false);
        }
    }
    async function remove(entry: FileEntry | null = selected) {
        if (!entry || !window.confirm(tr(`永久删除“${entry.path}”${entry.type === "directory" ? "及其全部内容" : ""}？`, `Permanently delete “${entry.path}”${entry.type === "directory" ? " and everything inside it" : ""}?`)))
            return;
        if (editor && (editor.path === entry.path || editor.path.startsWith(`${entry.path}/`)) && !discardAllowed())
            return;
        setMutating(true);
        setError("");
        try {
            await api(`${endpoint}?path=${encodeURIComponent(entry.path)}`, { method: "DELETE" });
            if (editor && (editor.path === entry.path || editor.path.startsWith(`${entry.path}/`)))
                setEditor(null);
            if (preview && (preview.path === entry.path || preview.path.startsWith(`${entry.path}/`))) setPreview(null);
            setSelected(null);
            const parent = entry.path.split("/").slice(0, -1).join("/");
            setExpanded(current => new Set([...current].filter(path => path !== entry.path && !path.startsWith(`${entry.path}/`))));
            await load(parent);
        }
        catch (err) {
            setError(errorMessage(err));
        }
        finally {
            setMutating(false);
        }
    }
    function previewKind(entry: FileEntry) {
        if (entry.type === "directory") return "";
        if (entry.type === "symlink") return tr("不可打开", "Unavailable");
        if (isSafeImageFile(entry.path) && entry.size <= FILE_TRANSFER_LIMITS.maxImagePreviewBytes) return tr("可预览", "Preview");
        if (isTextFile(entry.path) && entry.size <= FILE_TRANSFER_LIMITS.maxTextBytes) return tr("可预览", "Preview");
        const format = previewFormat(entry.path);
        if (format && entry.size <= DOCUMENT_PREVIEW_LIMITS[format]) return tr("可预览", "Preview");
        return tr("需下载", "Download");
    }
    function onTreeKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        const item = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[role="treeitem"]') : null;
        if (!item) return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'));
        const index = items.indexOf(item);
        if (index < 0) return;
        let target: HTMLButtonElement | undefined;
        if (event.key === "ArrowDown") target = items[index + 1];
        else if (event.key === "ArrowUp") target = items[index - 1];
        else if (event.key === "Home") target = items[0];
        else if (event.key === "End") target = items.at(-1);
        else if (event.key === "ArrowRight") {
            const path = item.dataset.filePath!;
            const entry = Object.values(tree).flat().find(value => value.path === path);
            if (entry?.type === "directory" && !expanded.has(path)) void openEntry(entry);
            else if (entry?.type === "directory") target = items[index + 1];
        } else if (event.key === "ArrowLeft") {
            const path = item.dataset.filePath!;
            if (expanded.has(path)) setExpanded(current => { const next = new Set(current); next.delete(path); return next; });
            else target = items.find(value => value.dataset.filePath === path.split("/").slice(0, -1).join("/"));
        } else return;
        event.preventDefault();
        target?.focus();
    }
    async function download(entry: FileEntry) {
        try { await downloadSmallFile(endpoint, entry.path, entry.name); }
        catch (cause) { setError(tr(`下载失败：${errorMessage(cause)}`, `Download failed: ${errorMessage(cause)}`)); }
    }
    function renderDirectory(path: string, level: number): React.ReactNode {
        return tree[path]?.map(entry => <div key={entry.path} role="none">
            <div className={`file-entry ${selected?.path === entry.path ? "selected" : ""}`} style={{ paddingLeft: 8 + level * 15 }}>
                <button role="treeitem" aria-level={level + 1} aria-selected={selected?.path === entry.path} aria-expanded={entry.type === "directory" ? expanded.has(entry.path) : undefined} data-file-path={entry.path} disabled={loadingFile || uploading} className="file-row" onClick={() => void openEntry(entry)} title={entry.path}>
                    <span className="file-chevron">{entry.type === "directory" && <Icon name="chevron" size={12} className={expanded.has(entry.path) ? "down" : ""}/>}</span>
                    <Icon name={entry.type === "directory" ? "folder" : "file"} size={16}/>
                    <span className="file-entry-name">{entry.name}</span>
                    {entry.type !== "directory" && <span className="file-kind-badge">{previewKind(entry)}</span>}
                </button>
                <details className="file-row-menu"><summary aria-label={tr(`${entry.name} 的操作`, `Actions for ${entry.name}`)} title={tr("更多操作", "More actions")}>···</summary><div>
                    {entry.type !== "symlink" && (entry.type === "directory" || entry.size > 50 * 1024 * 1024 ? <a download href={downloadUrl(endpoint, entry.path, entry.type === "directory")}>{tr(entry.type === "directory" ? "下载 ZIP" : "下载", entry.type === "directory" ? "Download ZIP" : "Download")}</a> : <button onClick={() => void download(entry)}>{tr("下载", "Download")}</button>)}
                    <button disabled={mutating || uploading} onClick={() => { setSelected(entry); beginAction("rename", entry); }}>{tr("重命名", "Rename")}</button>
                    <button className="danger" disabled={mutating || uploading} onClick={() => { setSelected(entry); void remove(entry); }}>{tr("删除", "Delete")}</button>
                </div></details>
            </div>
            {entry.type === "directory" && expanded.has(entry.path) && <div role="group">{treeErrors[entry.path] && <div className="file-tree-error" role="alert" style={{ paddingLeft: 35 + level * 15 }}>{treeErrors[entry.path]} <button onClick={() => void load(entry.path)}>{tr("重试", "Retry")}</button></div>}{loadingPaths.has(entry.path) && !tree[entry.path] ? <div className="tree-loading" style={{ paddingLeft: 35 + level * 15 }}>{tr("正在加载…", "Loading…")}</div> : tree[entry.path]?.length === 0 ? <div className="tree-loading" style={{ paddingLeft: 35 + level * 15 }}>{tr("空文件夹", "Empty folder")}</div> : renderDirectory(entry.path, level + 1)}</div>}
        </div>);
    }
    const activeFile = editor?.path || preview?.path;
    const currentDirectory = selected?.type === "directory" ? selected.path : selected?.path.split("/").slice(0, -1).join("/") || "";
    return <>
        <aside ref={drawerRef} tabIndex={-1} inert={!open} aria-hidden={!open} className={`files-panel file-workbench ${open ? "mobile-open" : ""}`}>
            <div className="file-workbench-tabs" role="group" aria-label={tr("文件工作台视图", "File workbench views")}>
                <button data-file-tab="files" aria-pressed={activeTab === "files"} className={activeTab === "files" ? "active" : ""} onClick={() => setActiveTab("files")}><Icon name="folder" size={15}/>{tr("文件", "Files")}</button>
                {activeFile && <button data-file-tab="preview" aria-pressed={activeTab === "preview"} className={activeTab === "preview" ? "active" : ""} title={activeFile} onClick={() => setActiveTab("preview")}><Icon name="file" size={15}/><span>{activeFile.split("/").at(-1)}</span>{dirty && <span className="unsaved-dot"/>}</button>}
                <button data-close-files className="icon-button file-workbench-close" aria-label={tr("关闭文件工作台", "Close file workbench")} onClick={closeDrawer}><Icon name="close" size={17}/></button>
            </div>
            {error && <ErrorBanner message={error} onDismiss={() => setError("")}/>}
            <div className="file-tree-pane" hidden={activeTab !== "files"}>
                <div className="file-pane-toolbar"><span>{currentDirectory || tr("工作区根目录", "Workspace root")}</span><a download href={downloadUrl(endpoint, "", true)} title={tr("下载工作区 ZIP", "Download workspace ZIP")}><Icon name="download" size={15}/>{tr("下载 ZIP", "Download ZIP")}</a></div>
                <div className="file-actions"><button disabled={uploading || mutating} onClick={() => { if (discardAllowed()) beginAction("file"); }}><Icon name="file" size={15}/>{tr("新建文件", "New file")}</button><button disabled={uploading || mutating} onClick={() => beginAction("directory")}><Icon name="plus" size={15}/>{tr("新建文件夹", "New folder")}</button></div>
                <label className="file-search"><span className="sr-only">{tr("搜索工作区文件", "Search workspace files")}</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={tr("搜索文件名或路径…", "Search filenames or paths…")}/></label>
                <FileUploads key={endpoint} endpoint={endpoint} disabled={saving || mutating || loadingFile} destination={currentDirectory} onRoot={() => setSelected(null)} onBusy={setUploading} beforeUpload={() => {
                    return !(saving || mutating || loadingFile);
                }} onChanged={() => setLocalRevision(value => value + 1)}>
                    {query.trim() ? <div className="file-tree file-search-results" role="list" aria-label={tr("文件搜索结果", "File search results")}>
                        {searchBusy && <div className="tree-loading" role="status">{tr("正在搜索…", "Searching…")}</div>}
                        {searchError && <div className="file-tree-error" role="alert">{searchError}<button onClick={() => setSearchRetry(value => value + 1)}>{tr("重试", "Retry")}</button></div>}
                        {!searchBusy && !searchError && searchResults.length === 0 && <div className="tree-loading">{tr("没有找到匹配的文件。", "No matching files found.")}</div>}
                        {!searchBusy && searchResults.map(entry => <div key={entry.path} role="listitem"><button className="file-search-result" onClick={() => { if (entry.type === "directory") setQuery(""); void openEntry(entry, entry.type === "directory"); }}><Icon name={entry.type === "directory" ? "folder" : "file"} size={15}/><span><strong>{entry.name}</strong><small>{entry.path}</small></span></button></div>)}
                        {!searchBusy && searchTruncated && <p className="file-search-limit">{tr("结果已截取前 100 项，请输入更具体的关键词。", "Showing the first 100 matches. Try a more specific search.")}</p>}
                    </div> : <div className="file-tree" role="tree" aria-label={tr("工作区文件", "Workspace files")} onKeyDown={onTreeKeyDown}>
                        {treeErrors[""] && <div className="file-tree-error" role="alert">{treeErrors[""]} <button onClick={() => void load("")}>{tr("重试", "Retry")}</button></div>}
                        {loadingPaths.has("") && !tree[""] ? <div className="tree-loading">{tr("正在加载文件…", "Loading files…")}</div> : tree[""]?.length === 0 ? <div className="files-empty"><Icon name="folder" size={26}/><p>{tr("还没有文件", "No files yet")}</p><span>{tr("拖入文件或文件夹，或让 Agent 开始创建。", "Drop files or folders here, or ask your agent to start building.")}</span></div> : renderDirectory("", 0)}
                    </div>}
                </FileUploads>
                <div className="files-footer"><Icon name="code" size={14}/><span>{tr("工作区文件会持久保存", "Workspace files are persistent")}</span></div>
            </div>
            <div className="file-preview-pane" hidden={activeTab !== "preview"}>
                {loadingFile && <div className="document-loading" role="status">{tr("正在打开文件…", "Opening file…")}</div>}
                {fileLoadError && <div className="file-inline-error" role="alert"><span>{fileLoadError}</span>{preview && isTextFile(preview.path) && <button onClick={() => void openEntry(preview, true)}>{tr("重试打开", "Retry opening")}</button>}<button aria-label={tr("关闭提示", "Dismiss message")} onClick={() => setFileLoadError("")}>×</button></div>}
                {editor && <section className="editor-panel" aria-label={editing ? tr("文件编辑器", "File editor") : tr("文本预览", "Text preview")}>
                    <div className="editor-heading"><div><Icon name="file" size={16}/><span title={editor.path}>{editor.path}</span>{dirty && <span className="unsaved-dot" title={tr("未保存的更改", "Unsaved changes")}/>}</div><button className="icon-button" disabled={saving} aria-label={tr("关闭文件", "Close file")} onClick={() => { if (discardAllowed()) { setEditor(null); setActiveTab("files"); } }}><Icon name="close" size={17}/></button></div>
                    <div className="editor-meta"><span>UTF-8 · {editor.content.split("\n").length} {tr("行", "lines")} · {editing ? tr("编辑中", "Editing") : tr("只读", "Read only")}</span><div className="file-editor-actions">
                        <button className="icon-button" onClick={() => { void downloadSmallFile(endpoint, editor.path, editor.path.split("/").at(-1) || "file").catch(cause => setFileLoadError(errorMessage(cause))); }} aria-label={tr("下载当前文件", "Download current file")} title={tr("下载已保存文件", "Download saved file")}><Icon name="download" size={14}/></button>
                        {editing ? <><button className="button button-small button-secondary" disabled={saving} onClick={() => setEditing(false)}>{tr("预览草稿", "Preview draft")}</button>{dirty && <button className="button button-small button-secondary" disabled={saving} onClick={() => { if (window.confirm(tr("放弃此文件尚未保存的更改？", "Discard unsaved changes to this file?"))) { setEditor({ ...editor, content: editor.original }); setConflict(null); } }}>{tr("放弃修改", "Discard changes")}</button>}<button className="button button-small button-secondary" onClick={() => void save()} disabled={!dirty || saving || !!conflict}><Icon name={saved && !dirty ? "check" : "save"} size={14}/>{saving ? tr("保存中…", "Saving…") : saved && !dirty ? tr("已保存", "Saved") : tr("保存", "Save")}</button></> : <><button className="button button-small button-secondary" onClick={() => setEditing(true)}><Icon name="edit" size={14}/>{tr("编辑", "Edit")}</button>{isMarkdownFile(editor.path) && <button className="button button-small button-secondary" onClick={() => setShowSource(value => !value)}>{showSource ? tr("阅读", "Read") : tr("源码", "Source")}</button>}</>}
                    </div></div>
                    {conflict && <div className="file-version-conflict" role="alert"><strong>{tr("Agent 已更新此文件", "This file was updated")}</strong><p>{tr("草稿仍在。你可以查看新版，或确认保留草稿后再保存。", "Your draft is intact. Review the latest version or choose to keep your draft before saving.")}</p><details><summary>{tr("查看新版内容", "View latest content")}</summary><CodeViewer code={conflict.content} language={languageFromFilename(editor.path)} filename={editor.path}/></details><div><button className="button button-small button-secondary" onClick={() => { setEditor({ ...editor, content: conflict.content, original: conflict.content, version: conflict.version }); setConflict(null); setFileLoadError(""); }}>{tr("使用新版", "Use latest")}</button><button className="button button-small button-secondary" onClick={() => { setEditor({ ...editor, original: conflict.content, version: conflict.version }); setConflict(null); setFileLoadError(""); }}>{tr("保留草稿并覆盖新版", "Keep draft and overwrite latest")}</button></div></div>}
                    {editing ? <textarea className="code-editor" aria-label={`${tr("编辑", "Edit")} ${editor.path}`} spellCheck={false} value={editor.content} onChange={event => { setEditor({ ...editor, content: event.target.value }); setSaved(false); }}/> : isMarkdownFile(editor.path) && !showSource ? <div className="file-text-reading"><RichContent content={editor.content} variant="file"/></div> : <div className="file-code-reading"><CodeViewer code={editor.content} language={languageFromFilename(editor.path)} filename={editor.path}/></div>}
                    <div className="editor-footer"><span>{dirty ? tr("未保存的更改", "Unsaved changes") : editing ? tr("所有更改已保存", "All changes saved") : tr("只读预览", "Read-only preview")}</span><span>{editing ? tr("按 ⌘ / Ctrl S 保存", "⌘ / Ctrl S to save") : tr("选择“编辑”以修改", "Choose Edit to make changes")}</span></div>
                </section>}
                {preview && <FilePreview key={`${preview.path}-${preview.modifiedAt}`} entry={preview} endpoint={endpoint} onClose={() => { setPreview(null); setActiveTab("files"); }}/>}
            </div>
        </aside>
        {action && <Modal title={action.kind === "file" ? tr("新建文件", "New file") : action.kind === "directory" ? tr("新建文件夹", "New folder") : tr("重命名", "Rename")} description={tr(`位置：${action.kind === "rename" ? action.path.split("/").slice(0, -1).join("/") || "/" : action.path || "/"}`, `Location: ${action.kind === "rename" ? action.path.split("/").slice(0, -1).join("/") || "/" : action.path || "/"}`)} onClose={() => { if (!mutating) setAction(null); }}><form onSubmit={performAction}>
            <label>{tr("名称", "Name")}<input autoFocus required value={actionValue} onChange={event => setActionValue(event.target.value)} placeholder={action.kind === "directory" ? tr("例如 components", "e.g. components") : tr("例如 index.ts", "e.g. index.ts")}/></label>
            <p className="file-target-path">{tr("目标路径：", "Target path: ")}{[action.kind === "rename" ? action.path.split("/").slice(0, -1).join("/") : action.path, actionValue.trim() || "…"].filter(Boolean).join("/")}</p>
            {actionError && <ErrorBanner message={actionError}/>}
            <div className="modal-actions"><button className="button button-secondary" type="button" disabled={mutating} onClick={() => setAction(null)}>{tr("取消", "Cancel")}</button><button className="button button-primary" disabled={mutating}>{mutating ? tr("保存中…", "Saving…") : action.kind === "rename" ? tr("重命名", "Rename") : tr("创建", "Create")}</button></div>
        </form></Modal>}
    </>;
}
