"use client";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { FILE_TRANSFER_LIMITS } from "@cloud-work/protocol";
import { api, errorMessage } from "./client";
import { ErrorBanner, Icon } from "./ui";
import { droppedFiles, formatFileSize, prepareUploadSelection, type UploadSelection, type UploadFile } from "./file-transfer";

type QueueFile = UploadFile & { status: "pending" | "uploading" | "done" | "skipped" | "failed"; resultPath?: string };
type ConflictChoice = "replace" | "rename" | "skip" | "cancel";
type Operation = { cancelled: boolean; xhr: XMLHttpRequest | null; batchId: string | null; controller: AbortController };
class UploadError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}

function uploadFile(endpoint: string, operation: Operation, item: UploadFile, conflict: "error" | "replace" | "rename", onProgress: (bytes: number) => void) {
    return new Promise<{ path: string; size: number }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        operation.xhr = xhr;
        xhr.open("PUT", `${endpoint}/uploads/${encodeURIComponent(operation.batchId!)}?${new URLSearchParams({ path: item.path, conflict })}`);
        xhr.timeout = FILE_TRANSFER_LIMITS.timeoutMs;
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = event => onProgress(Math.min(event.loaded, item.file.size));
        xhr.onerror = () => reject(new UploadError("The upload connection was interrupted. Retry the remaining files.", 0));
        xhr.ontimeout = () => reject(new UploadError("The upload timed out. Retry the remaining files.", 408));
        xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
        xhr.onload = () => {
            let data: { path?: string; size?: number; error?: string } = {};
            try { data = JSON.parse(xhr.responseText); } catch { /* Report the HTTP failure below. */ }
            if (xhr.status < 200 || xhr.status >= 300) reject(new UploadError(data.error || `Upload failed (${xhr.status}).`, xhr.status));
            else if (typeof data.path !== "string" || typeof data.size !== "number") reject(new UploadError("The upload service returned an invalid response.", 502));
            else resolve({ path: data.path, size: data.size });
        };
        if (operation.cancelled) reject(new DOMException("Upload cancelled", "AbortError"));
        else xhr.send(item.file);
    });
}

export function FileUploads({ endpoint, destination, onRoot, onChanged, beforeUpload, onBusy, disabled = false, children }: {
    endpoint: string;
    destination: string;
    onRoot: () => void;
    onChanged: () => void;
    beforeUpload: () => boolean;
    onBusy: (busy: boolean) => void;
    disabled?: boolean;
    children: ReactNode;
}) {
    const [queue, setQueue] = useState<QueueFile[]>([]);
    const [directories, setDirectories] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [progress, setProgress] = useState({ path: "", bytes: 0 });
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [conflictPath, setConflictPath] = useState("");
    const [folderHint, setFolderHint] = useState(false);
    const filesRef = useRef<HTMLInputElement>(null);
    const folderRef = useRef<HTMLInputElement>(null);
    const activeRef = useRef<Operation | null>(null);
    const conflictRef = useRef<((choice: ConflictChoice) => void) | null>(null);
    const mounted = useRef(true);
    const dragDepth = useRef(0);
    const selecting = useRef(false);
    const callbacks = useRef({ onBusy, onChanged, beforeUpload });
    callbacks.current = { onBusy, onChanged, beforeUpload };

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            const operation = activeRef.current;
            if (!operation) return;
            operation.cancelled = true;
            operation.controller.abort();
            operation.xhr?.abort();
            conflictRef.current?.("cancel");
            if (operation.batchId) void fetch(`${endpoint}/uploads/${encodeURIComponent(operation.batchId)}`, { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => {});
        };
    }, [endpoint]);
    useEffect(() => {
        if (!busy) return;
        function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); }
        function beforeNavigation(event: MouseEvent) {
            const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
            if (!link || link.hasAttribute("download") || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            if (!window.confirm("Leave this workspace and cancel the remaining upload? Completed files will be kept.")) { event.preventDefault(); event.stopPropagation(); }
        }
        window.addEventListener("beforeunload", beforeUnload);
        document.addEventListener("click", beforeNavigation, true);
        return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", beforeNavigation, true); };
    }, [busy]);

    function chooseConflict(choice: ConflictChoice) {
        conflictRef.current?.(choice);
        conflictRef.current = null;
        setConflictPath("");
    }
    function cancel() {
        const operation = activeRef.current;
        if (!operation) return;
        operation.cancelled = true;
        operation.controller.abort();
        operation.xhr?.abort();
        chooseConflict("cancel");
    }
    async function run(files: QueueFile[], folders: string[]) {
        if (activeRef.current) return;
        const operation: Operation = { cancelled: false, xhr: null, batchId: null, controller: new AbortController() };
        activeRef.current = operation;
        setBusy(true); callbacks.current.onBusy(true);
        setError(""); setNotice(""); setProgress({ path: "", bytes: 0 });
        const current: QueueFile[] = files.map(item => ({ ...item, status: item.status === "failed" || item.status === "uploading" ? "pending" : item.status }));
        const remaining = current.filter(item => item.status === "pending");
        setQueue([...current]); setDirectories(folders);
        let failed = false;
        try {
            const manifest = await api<{ id: string }>(`${endpoint}/uploads`, { method: "POST", signal: AbortSignal.any([operation.controller.signal, AbortSignal.timeout(FILE_TRANSFER_LIMITS.timeoutMs)]), body: JSON.stringify({ files: remaining.map(item => ({ path: item.path, size: item.file.size })), directories: folders }) });
            operation.batchId = manifest.id;
            for (const item of remaining) {
                if (operation.cancelled || !mounted.current) break;
                item.status = "uploading"; setQueue([...current]);
                let mode: "error" | "replace" | "rename" = "error";
                while (!operation.cancelled) {
                    setProgress({ path: item.path, bytes: 0 });
                    try {
                        const result = await uploadFile(endpoint, operation, item, mode, bytes => { if (mounted.current) setProgress({ path: item.path, bytes }); });
                        item.status = "done"; item.resultPath = result.path;
                        setQueue([...current]); setProgress({ path: "", bytes: 0 });
                        break;
                    } catch (uploadError) {
                        if (operation.cancelled) break;
                        if (uploadError instanceof UploadError && uploadError.status === 409) {
                            setProgress({ path: item.path, bytes: 0 });
                            const choice = await new Promise<ConflictChoice>(resolve => { conflictRef.current = resolve; setConflictPath(item.path); });
                            if (choice === "skip") { item.status = "skipped"; setQueue([...current]); break; }
                            if (choice === "cancel") break;
                            mode = choice;
                        } else { item.status = "failed"; setQueue([...current]); throw uploadError; }
                    }
                }
            }
            if (mounted.current) setNotice(operation.cancelled ? "Upload cancelled. Completed files and folders were kept." : `Uploaded ${current.filter(item => item.status === "done").length} files${current.some(item => item.status === "skipped") ? `; ${current.filter(item => item.status === "skipped").length} skipped` : ""}${!current.length ? " and created the selected folders" : ""}.`);
        } catch (err) {
            failed = true;
            if (mounted.current) {
                if (operation.cancelled) setNotice("Upload cancelled. Completed files and folders were kept.");
                else setError(errorMessage(err));
            }
        } finally {
            for (const item of current) if (item.status === "uploading") item.status = "pending";
            if (operation.batchId) {
                try { await api(`${endpoint}/uploads/${encodeURIComponent(operation.batchId)}`, { method: "DELETE", signal: AbortSignal.timeout(15_000) }); }
                catch { if (mounted.current) setError("The upload stopped, but temporary upload cleanup could not be confirmed. It will expire automatically; completed files are kept."); }
            }
            activeRef.current = null;
            if (mounted.current) {
                setQueue([...current]); setProgress({ path: "", bytes: 0 }); setBusy(false); setConflictPath("");
                callbacks.current.onBusy(false); callbacks.current.onChanged();
                if (!current.length && !failed && !operation.cancelled) setDirectories([]);
            }
        }
    }
    async function select(selection: UploadSelection) {
        const prepared = prepareUploadSelection(selection.files, selection.directories, destination);
        if (!callbacks.current.beforeUpload()) return;
        await run(prepared.files.map(item => ({ ...item, status: "pending" })), prepared.directories);
    }
    function picked(list: FileList | null, folder: boolean) {
        const files = Array.from(list ?? []).map(file => ({ path: folder ? file.webkitRelativePath || file.name : file.name, file }));
        if (!files.length) return;
        void select({ files, directories: [] }).catch(err => setError(errorMessage(err)));
    }
    async function drop(event: DragEvent<HTMLDivElement>) {
        event.preventDefault(); dragDepth.current = 0; setDragging(false);
        if (busy || disabled || selecting.current) return;
        const items = Array.from(event.dataTransfer.items);
        const fallback = Array.from(event.dataTransfer.files);
        if (!items.some(item => item.kind === "file") && !fallback.length) return;
        selecting.current = true; setScanning(true); setFolderHint(true); setError("");
        try {
            const selection = await droppedFiles(items, fallback);
            setScanning(false);
            if (mounted.current) await select(selection);
        } catch (err) { if (mounted.current) setError(errorMessage(err)); }
        finally { selecting.current = false; if (mounted.current) setScanning(false); }
    }
    const completedBytes = queue.filter(item => item.status === "done").reduce((sum, item) => sum + item.file.size, 0);
    const totalBytes = queue.reduce((sum, item) => sum + item.file.size, 0);
    const remaining = queue.some(item => item.status === "pending" || item.status === "failed" || item.status === "uploading") || (!queue.length && directories.length > 0);
    return <div className={`file-transfer-zone ${dragging ? "is-dragging" : ""}`} onDragEnter={event => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); dragDepth.current++; if (!busy && !disabled) setDragging(true); } }} onDragLeave={event => { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }} onDragOver={event => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = busy || disabled ? "none" : "copy"; } }} onDrop={event => void drop(event)}>
        <div className="file-transfer-controls">
            <div className="file-transfer-buttons"><button disabled={busy || scanning || disabled} onClick={() => filesRef.current?.click()}><Icon name="upload" size={14}/>Upload files</button><button disabled={busy || scanning || disabled} onClick={() => { setFolderHint(true); folderRef.current?.click(); }}><Icon name="folder" size={14}/>Upload folder</button></div>
            <input ref={filesRef} type="file" multiple className="file-picker-input" aria-label="Choose files to upload" onChange={event => { picked(event.target.files, false); event.target.value = ""; }}/>
            <input ref={folderRef} type="file" multiple {...{ webkitdirectory: "" }} className="file-picker-input" aria-label="Choose folder to upload" onChange={event => { picked(event.target.files, true); event.target.value = ""; }}/>
            <div className="file-upload-destination"><span title={destination || "/"}>Upload to: {destination || "Workspace root"}</span>{destination && <button className="text-button" disabled={busy} onClick={onRoot}>Use root</button>}</div>
            {folderHint && <p className="file-transfer-hint">Empty folders require drag-and-drop with browser directory support. The folder picker and unsupported browsers only upload files.</p>}
        </div>
        {error && <ErrorBanner message={error} onDismiss={() => setError("")}/>}
        {scanning && <div className="tree-loading" role="status">Reading selected folders…</div>}
        {children}
        {dragging && <div className="file-drop-overlay"><Icon name="upload" size={26}/><strong>Drop files or folders</strong><span>Into {destination || "workspace root"}</span></div>}
        {(queue.length > 0 || directories.length > 0 || notice || busy) && <section className="file-upload-progress" aria-label="File uploads">
            <div className="file-upload-summary"><strong>{busy ? conflictPath ? "Choose how to resolve the conflict" : "Uploading…" : "File uploads"}</strong>{busy ? <button className="text-button" onClick={cancel}>Cancel</button> : <button className="icon-button" aria-label="Dismiss upload results" onClick={() => { setQueue([]); setDirectories([]); setNotice(""); setError(""); }}><Icon name="close" size={14}/></button>}</div>
            {busy && <><progress max={Math.max(totalBytes, 1)} value={completedBytes + progress.bytes} aria-label="Uploaded bytes"/><p className="file-transfer-hint">{formatFileSize(completedBytes + progress.bytes)} / {formatFileSize(totalBytes)} · {queue.filter(item => item.status === "done").length}/{queue.length} files</p><p className="file-upload-current" title={progress.path}>{progress.path || "Preparing folders…"}</p></>}
            {conflictPath && <div className="file-upload-conflict" role="alert"><p>“{conflictPath}” already exists.</p><div><button onClick={() => chooseConflict("replace")}>Replace</button><button onClick={() => chooseConflict("skip")}>Skip</button><button onClick={() => chooseConflict("rename")}>Keep both</button></div></div>}
            {notice && <p className="file-transfer-hint" role="status">{notice}</p>}
            {!busy && remaining && <button className="text-button" disabled={disabled} onClick={() => { if (beforeUpload()) void run(queue, directories); }}>Retry remaining files</button>}
            {!busy && queue.some(item => item.resultPath && item.resultPath !== item.path) && <ul className="file-upload-renames">{queue.filter(item => item.resultPath && item.resultPath !== item.path).map(item => <li key={item.path}>Saved as {item.resultPath}</li>)}</ul>}
        </section>}
    </div>;
}
