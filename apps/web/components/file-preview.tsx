"use client";
import { useState } from "react";
import { FILE_TRANSFER_LIMITS } from "@cloud-work/protocol";
import type { FileEntry } from "./client";
import { Icon } from "./ui";
import { downloadUrl, formatFileSize, isSafeImageFile, isTextFile } from "./file-transfer";
import { useLocale } from "./locale";

export function FilePreview({ entry, endpoint, onClose }: { entry: FileEntry; endpoint: string; onClose: () => void }) {
    const { tr } = useLocale();
    const [imageError, setImageError] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const image = isSafeImageFile(entry.path) && entry.size <= FILE_TRANSFER_LIMITS.maxImagePreviewBytes;
    const tooLarge = (isSafeImageFile(entry.path) && !image) || (isTextFile(entry.path) && entry.size > FILE_TRANSFER_LIMITS.maxTextBytes);
    return <section className="editor-panel file-preview-panel" aria-label={tr("文件预览", "File preview")}>
        <div className="editor-heading"><div><Icon name="file" size={16}/><span title={entry.path}>{entry.path}</span></div><button className="icon-button" aria-label={tr("关闭文件预览", "Close file preview")} onClick={onClose}><Icon name="close" size={17}/></button></div>
        <div className="editor-meta"><span>{formatFileSize(entry.size)}</span><a className="button button-small button-secondary" download href={downloadUrl(endpoint, entry.path)}><Icon name="download" size={14}/>{tr("下载", "Download")}</a></div>
        {image && !imageError ? <div className="file-image-preview">{!loaded && <p role="status">{tr("正在加载图片…", "Loading image…")}</p>}<img src={`${downloadUrl(endpoint, entry.path)}&inline=1`} alt={entry.name} onLoad={() => setLoaded(true)} onError={() => setImageError(true)}/></div> : <div className="file-download-preview"><Icon name="file" size={35}/><h3>{imageError ? tr("无法预览图片", "Image preview unavailable") : tooLarge ? tr("文件过大，无法预览", "This file is too large to preview") : tr("下载后打开此文件", "Download this file to open it")}</h3><p>{imageError ? tr("此图片无法安全显示。", "The file could not be displayed as a supported image.") : tooLarge ? tr(`文本预览上限 ${formatFileSize(FILE_TRANSFER_LIMITS.maxTextBytes)}，图片预览上限 ${formatFileSize(FILE_TRANSFER_LIMITS.maxImagePreviewBytes)}。`, `Text previews support up to ${formatFileSize(FILE_TRANSFER_LIMITS.maxTextBytes)}; image previews support up to ${formatFileSize(FILE_TRANSFER_LIMITS.maxImagePreviewBytes)}.`) : tr("此文件类型暂不支持站内预览。", "This file type does not have an in-app preview.")}</p><a className="button button-secondary" download href={downloadUrl(endpoint, entry.path)}><Icon name="download" size={16}/>{tr("下载文件", "Download file")}</a></div>}
    </section>;
}
