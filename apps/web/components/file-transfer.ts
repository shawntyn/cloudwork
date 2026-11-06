import { FILE_TRANSFER_LIMITS } from "@cloud-work/protocol";

export type UploadFile = { path: string; file: File };
export type UploadSelection = { files: UploadFile[]; directories: string[] };
export class FileTransferValidationError extends Error {
    constructor(readonly code: "unsafe_path" | "path_conflict" | "duplicate_path" | "file_too_large" | "batch_too_large" | "too_many_entries" | "empty_selection", readonly detail: string, message: string) {
        super(message);
    }
}

export function formatFileSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    const unit = bytes < 1024 ** 2 ? "KiB" : bytes < 1024 ** 3 ? "MiB" : "GiB";
    const divisor = unit === "KiB" ? 1024 : unit === "MiB" ? 1024 ** 2 : 1024 ** 3;
    return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

function checkPath(path: string) {
    if (!path || path.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
        throw new FileTransferValidationError("unsafe_path", path, `Cannot upload an unsafe path: ${path}`);
    }
}

export function prepareUploadSelection(files: UploadFile[], directories: string[], destination: string): UploadSelection {
    const prefix = destination ? `${destination}/` : "";
    const entries = new Map<string, "file" | "directory">();
    const folders = new Set<string>();
    let bytes = 0;
    function addDirectory(path: string) {
        checkPath(path);
        if (entries.get(path) === "file") throw new FileTransferValidationError("path_conflict", path, `A file and folder use the same path: ${path}`);
        entries.set(path, "directory");
        folders.add(path);
    }
    function parents(path: string) {
        const parts = path.split("/");
        for (let count = 1; count < parts.length; count++) addDirectory(parts.slice(0, count).join("/"));
    }
    for (const directory of directories) {
        checkPath(directory);
        const path = prefix + directory;
        parents(path);
        addDirectory(path);
    }
    const prepared = files.map(({ path: relativePath, file }) => {
        checkPath(relativePath);
        const path = prefix + relativePath;
        checkPath(path);
        if (entries.has(path)) throw new FileTransferValidationError("duplicate_path", path, `The selection contains a duplicate path: ${path}`);
        if (file.size > FILE_TRANSFER_LIMITS.maxFileBytes) throw new FileTransferValidationError("file_too_large", file.name, `${file.name} exceeds the ${formatFileSize(FILE_TRANSFER_LIMITS.maxFileBytes)} file limit.`);
        bytes += file.size;
        if (bytes > FILE_TRANSFER_LIMITS.maxBatchBytes) throw new FileTransferValidationError("batch_too_large", "", `Upload batches must be no larger than ${formatFileSize(FILE_TRANSFER_LIMITS.maxBatchBytes)}.`);
        parents(path);
        entries.set(path, "file");
        return { path, file };
    });
    if (entries.size > FILE_TRANSFER_LIMITS.maxEntries) throw new FileTransferValidationError("too_many_entries", "", `Choose at most ${FILE_TRANSFER_LIMITS.maxEntries.toLocaleString()} files and folders per upload.`);
    if (!entries.size) throw new FileTransferValidationError("empty_selection", "", "No files or folders were selected. The folder picker cannot include empty folders; drag the folder here instead.");
    return { files: prepared, directories: [...folders] };
}

export async function droppedFiles(items: DataTransferItem[], fallback: File[]): Promise<UploadSelection> {
    // Obtain all entries synchronously while the drop event's data store is readable.
    const entries = items.filter(item => item.kind === "file").map(item => item.webkitGetAsEntry?.());
    if (!entries.length || entries.some(entry => !entry)) return { files: fallback.map(file => ({ path: file.name, file })), directories: [] };
    const files: UploadFile[] = [];
    const directories: string[] = [];
    let count = 0;
    let bytes = 0;
    async function visit(entry: FileSystemEntry, parent: string) {
        if (++count > FILE_TRANSFER_LIMITS.maxEntries) throw new FileTransferValidationError("too_many_entries", "", `Choose at most ${FILE_TRANSFER_LIMITS.maxEntries.toLocaleString()} files and folders per upload.`);
        const path = parent ? `${parent}/${entry.name}` : entry.name;
        checkPath(path);
        if (entry.isFile) {
            const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
            if (file.size > FILE_TRANSFER_LIMITS.maxFileBytes) throw new FileTransferValidationError("file_too_large", file.name, `${file.name} exceeds the ${formatFileSize(FILE_TRANSFER_LIMITS.maxFileBytes)} file limit.`);
            bytes += file.size;
            if (bytes > FILE_TRANSFER_LIMITS.maxBatchBytes) throw new FileTransferValidationError("batch_too_large", "", `Upload batches must be no larger than ${formatFileSize(FILE_TRANSFER_LIMITS.maxBatchBytes)}.`);
            files.push({ path, file });
        } else if (entry.isDirectory) {
            directories.push(path);
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            while (true) {
                const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
                if (!children.length) break;
                for (const child of children) await visit(child, path);
            }
        }
    }
    for (const entry of entries) await visit(entry!, "");
    return { files, directories };
}

export function downloadUrl(endpoint: string, path: string, directory = false) {
    const query = new URLSearchParams({ path });
    if (directory) query.set("archive", "1");
    return `${endpoint}/download?${query}`;
}
export async function downloadSmallFile(endpoint: string, path: string, filename: string): Promise<void> {
    const response = await fetch(downloadUrl(endpoint, path), { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    if (Number(response.headers.get("content-length")) > 50 * 1024 * 1024) throw new Error("File became too large for an in-app download. Refresh files and use the browser download.");
    const blob = await response.blob();
    if (blob.size > 50 * 1024 * 1024) throw new Error("File became too large for an in-app download.");
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const binaryExtensions = new Set("pdf doc docx docm dot dotx dotm xls xlsx xlsm xlsb xlt xltx ppt pptx pptm pps ppsx odt ods odp rtf pages numbers key zip tar gz tgz bz2 xz zst rar 7z jar whl png jpg jpeg gif webp avif heic heif bmp ico tif tiff psd svg svgz mp3 mp4 m4a m4v mov mkv avi wav ogg flac aac opus wma webm exe dll so dylib wasm o a class pyc pyo bin db sqlite sqlite3 ttf otf woff woff2 eot".split(" "));
/** A candidate for the Runtime's strict UTF-8 check, not proof that the file is text. */
export function isTextFile(path: string) {
    const name = path.split("/").at(-1)!.toLowerCase();
    return name !== ".ds_store" && (!name.includes(".") || !binaryExtensions.has(name.split(".").at(-1)!));
}

export function isSafeImageFile(path: string) { return /\.(png|jpe?g|gif|webp)$/i.test(path); }
export function isMarkdownFile(path: string) { return /\.(md|markdown|mdx)$/i.test(path); }
export const DOCUMENT_PREVIEW_LIMITS = { pdf: 30 * 1024 * 1024, docx: 12 * 1024 * 1024, xlsx: 6 * 1024 * 1024 } as const;
export function previewFormat(path: string): "pdf" | "docx" | "xlsx" | null {
    if (/\.pdf$/i.test(path)) return "pdf";
    if (/\.docx$/i.test(path)) return "docx";
    if (/\.xlsx$/i.test(path)) return "xlsx";
    return null;
}
