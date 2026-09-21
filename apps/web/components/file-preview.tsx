"use client";
import { useState } from "react";
import { FILE_TRANSFER_LIMITS } from "@cloud-work/protocol";
import type { FileEntry } from "./client";
import { Icon } from "./ui";
import { downloadUrl, formatFileSize, isSafeImageFile, isTextFile } from "./file-transfer";

export function FilePreview({ entry, endpoint, onClose }: { entry: FileEntry; endpoint: string; onClose: () => void }) {
    const [imageError, setImageError] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const image = isSafeImageFile(entry.path) && entry.size <= FILE_TRANSFER_LIMITS.maxImagePreviewBytes;
    const tooLarge = (isSafeImageFile(entry.path) && !image) || (isTextFile(entry.path) && entry.size > FILE_TRANSFER_LIMITS.maxTextBytes);
    return <section className="editor-panel file-preview-panel" aria-label="File preview">
        <div className="editor-heading"><div><Icon name="file" size={16}/><span title={entry.path}>{entry.path}</span></div><button className="icon-button" aria-label="Close file preview" onClick={onClose}><Icon name="close" size={17}/></button></div>
        <div className="editor-meta"><span>{formatFileSize(entry.size)}</span><a className="button button-small button-secondary" download href={downloadUrl(endpoint, entry.path)}><Icon name="download" size={14}/>Download</a></div>
        {image && !imageError ? <div className="file-image-preview">{!loaded && <p role="status">Loading image…</p>}<img src={`${downloadUrl(endpoint, entry.path)}&inline=1`} alt={entry.name} onLoad={() => setLoaded(true)} onError={() => setImageError(true)}/></div> : <div className="file-download-preview"><Icon name="file" size={35}/><h3>{imageError ? "Image preview unavailable" : tooLarge ? "This file is too large to preview" : "Download this file to open it"}</h3><p>{imageError ? "The file could not be displayed as a supported image." : tooLarge ? `Text previews support up to ${formatFileSize(FILE_TRANSFER_LIMITS.maxTextBytes)}; image previews support up to ${formatFileSize(FILE_TRANSFER_LIMITS.maxImagePreviewBytes)}.` : "This file type does not have an in-app preview."}</p><a className="button button-secondary" download href={downloadUrl(endpoint, entry.path)}><Icon name="download" size={16}/>Download file</a></div>}
    </section>;
}
