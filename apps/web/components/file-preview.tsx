"use client";
import { useEffect, useState } from "react";
import { FILE_TRANSFER_LIMITS } from "@cloud-work/protocol";
import type { FileEntry } from "./client";
import { Icon } from "./ui";
import { DocumentPreview } from "./document-preview";
import { downloadUrl, formatFileSize, isSafeImageFile, previewFormat } from "./file-transfer";
import { useLocale } from "./locale";

export function FilePreview({ entry, endpoint, onClose }: { entry: FileEntry; endpoint: string; onClose: () => void }) {
    const { tr } = useLocale();
    const [imageError, setImageError] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [downloadError, setDownloadError] = useState("");
    const [downloading, setDownloading] = useState(false);
    const image = isSafeImageFile(entry.path) && entry.size <= FILE_TRANSFER_LIMITS.maxImagePreviewBytes;
    const format = previewFormat(entry.path);
    useEffect(() => { setImageError(false); setLoaded(false); setDownloadError(""); }, [entry.path, entry.modifiedAt]);
    async function download() {
        setDownloadError("");
        // Native streaming avoids buffering large files; smaller downloads can
        // report an HTTP failure next to the file.
        if (entry.size > 50 * 1024 * 1024) {
            const anchor = document.createElement("a");
            anchor.href = downloadUrl(endpoint, entry.path);
            anchor.download = entry.name;
            anchor.click();
            return;
        }
        setDownloading(true);
        try {
            const response = await fetch(downloadUrl(endpoint, entry.path), { credentials: "same-origin", cache: "no-store" });
            if (!response.ok) throw new Error(tr(`下载失败（${response.status}），请重试。`, `Download failed (${response.status}). Please retry.`));
            if (Number(response.headers.get("content-length")) > 50 * 1024 * 1024) throw new Error(tr("文件已变大，请刷新列表后用浏览器下载。", "The file grew. Refresh files and use the browser download."));
            const blob = await response.blob();
            if (blob.size > 50 * 1024 * 1024) throw new Error(tr("文件已超过站内下载上限，请刷新列表后用浏览器下载。", "The file exceeds the in-app download limit. Refresh files and use the browser download."));
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = entry.name;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (cause) {
            setDownloadError(cause instanceof Error ? cause.message : tr("下载失败，请重试。", "Download failed. Please retry."));
        } finally { setDownloading(false); }
    }
    return <section className="editor-panel file-preview-panel" aria-label={tr("文件预览", "File preview")}>
        <div className="editor-heading"><div><Icon name="file" size={16}/><span title={entry.path}>{entry.path}</span></div><button className="icon-button" aria-label={tr("关闭文件预览", "Close file preview")} onClick={onClose}><Icon name="close" size={17}/></button></div>
        <div className="editor-meta"><span>{formatFileSize(entry.size)}</span><button className="button button-small button-secondary" disabled={downloading} onClick={() => void download()}><Icon name="download" size={14}/>{downloading ? tr("下载中…", "Downloading…") : tr("下载原件", "Download original")}</button></div>
        {downloadError && <p className="document-error" role="alert">{downloadError}</p>}
        {image && !imageError ? <div className="file-image-preview">{!loaded && <p role="status">{tr("正在加载图片…", "Loading image…")}</p>}<img src={`${downloadUrl(endpoint, entry.path)}&inline=1`} alt={entry.name} onLoad={() => setLoaded(true)} onError={() => setImageError(true)}/></div>
            : format ? <DocumentPreview entry={entry} endpoint={endpoint}/>
                : <div className="file-download-preview"><Icon name="file" size={35}/><h3>{imageError ? tr("无法预览图片", "Image preview unavailable") : tr("此文件可下载查看", "Download to view this file")}</h3><p>{imageError ? tr("此图片无法安全显示。", "The image could not be displayed safely.") : tr("此文件类型暂不支持站内预览。", "This file type does not have an in-app preview.")}</p><button className="button button-secondary" disabled={downloading} onClick={() => void download()}><Icon name="download" size={16}/>{tr("下载文件", "Download file")}</button></div>}
    </section>;
}
