export class DocumentPreviewError extends Error {
    constructor(readonly reason: "parse" | "timeout" | "size", cause?: unknown) {
        super(cause instanceof Error ? cause.message : String(cause ?? reason));
    }
}

export function documentPreviewErrorMessage(error: unknown, tr: (zh: string, en: string) => string): string | null {
    if (!(error instanceof DocumentPreviewError)) return null;
    if (error.reason === "timeout") return tr("预览超时。请重试或下载原文件。", "Preview timed out. Retry or download the original file.");
    if (error.reason === "size") return tr("文件超过预览大小上限。可下载原文件。", "File exceeds the preview size limit. Download the original file.");
    return tr("无法预览此文件，可能已损坏或格式不受支持。可下载原文件。", "This file cannot be previewed. It may be damaged or unsupported. Download the original file.");
}
