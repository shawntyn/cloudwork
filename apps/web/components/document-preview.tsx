"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "./client";
import { errorMessage } from "./client";
import { DOCUMENT_PREVIEW_LIMITS, downloadUrl, formatFileSize, previewFormat } from "./file-transfer";
import { DocumentPreviewError, documentPreviewErrorMessage } from "./document-preview-errors";
import { useLocale } from "./locale";

type Format = keyof typeof DOCUMENT_PREVIEW_LIMITS;
type Spreadsheet = { sheet: string; data: unknown[][]; totalRows: number };
type Loaded = { kind: "pdf"; bytes: Uint8Array } | { kind: "docx"; html: string } | { kind: "xlsx"; sheets: Spreadsheet[] };

function readableCell(value: unknown, locale: string) {
    if (value instanceof Date) return new Intl.DateTimeFormat(locale).format(value);
    if (value === null || value === undefined) return "";
    return String(value);
}

function parseInWorker(kind: "docx" | "xlsx", bytes: ArrayBuffer, signal: AbortSignal): Promise<{ kind: "docx"; html: string } | { kind: "xlsx"; sheets: Spreadsheet[] }> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./document-parse.worker.ts", import.meta.url), { type: "module" });
        let timer = 0;
        const cleanup = () => { window.clearTimeout(timer); signal.removeEventListener("abort", abort); worker.terminate(); };
        const abort = () => { cleanup(); reject(new DOMException("Preview cancelled", "AbortError")); };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        timer = window.setTimeout(() => { cleanup(); reject(new DocumentPreviewError("timeout")); }, 20_000);
        worker.onmessage = (event: MessageEvent<{ kind?: "docx" | "xlsx"; html?: string; sheets?: Spreadsheet[]; error?: string; reason?: "size" | "parse" }>) => {
            cleanup();
            if (event.data.error) reject(new DocumentPreviewError(event.data.reason === "size" ? "size" : "parse", new Error(event.data.error)));
            else if (event.data.kind === "docx" && typeof event.data.html === "string") resolve({ kind: "docx", html: event.data.html });
            else if (event.data.kind === "xlsx" && Array.isArray(event.data.sheets)) resolve({ kind: "xlsx", sheets: event.data.sheets });
            else reject(new DocumentPreviewError("parse"));
        };
        worker.onerror = () => { cleanup(); reject(new DocumentPreviewError("parse")); };
        worker.postMessage({ kind, bytes }, [bytes]);
    });
}

async function loadDocument(format: Format, bytes: ArrayBuffer, signal: AbortSignal): Promise<Loaded> {
    if (format === "pdf") return { kind: "pdf", bytes: new Uint8Array(bytes) };
    try {
        if (format === "docx") {
            const [result, purifierModule] = await Promise.all([parseInWorker("docx", bytes, signal), import("dompurify")]);
            if (result.kind !== "docx") throw new DocumentPreviewError("parse");
            // Mammoth does not sanitize generated HTML. Keep only reading elements,
            // strip every live link and allow images only from embedded raster data.
            const purifier = purifierModule.default;
            const clean = purifier.sanitize(result.html, {
                ALLOWED_TAGS: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "u", "s", "sub", "sup", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "blockquote", "a", "img"],
                ALLOWED_ATTR: ["alt", "src", "colspan", "rowspan"],
                FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "svg", "math"],
            });
            const document = new DOMParser().parseFromString(clean, "text/html");
            for (const image of document.querySelectorAll("img")) {
                if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(image.getAttribute("src") ?? "")) image.remove();
            }
            const html = document.body.innerHTML;
            if (html.length > 6_000_000) throw new DocumentPreviewError("size");
            return { kind: "docx", html };
        }
        const result = await parseInWorker("xlsx", bytes, signal);
        if (result.kind !== "xlsx") throw new DocumentPreviewError("parse");
        return result;
    } catch (cause) {
        if (cause instanceof DocumentPreviewError || cause instanceof DOMException && cause.name === "AbortError") throw cause;
        throw new DocumentPreviewError("parse", cause);
    }
}

export function DocumentPreview({ entry, endpoint }: { entry: FileEntry; endpoint: string }) {
    const { tr } = useLocale();
    const format = previewFormat(entry.path);
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        if (!format || entry.size > DOCUMENT_PREVIEW_LIMITS[format]) return;
        const controller = new AbortController();
        setLoaded(null); setError(""); setLoading(true);
        void (async () => {
            try {
                const response = await fetch(downloadUrl(endpoint, entry.path), { credentials: "same-origin", cache: "no-store", signal: controller.signal });
                if (!response.ok) throw new Error(tr(`文件加载失败（${response.status}）。`, `File could not be loaded (${response.status}).`));
                const length = Number(response.headers.get("content-length"));
                if (length > DOCUMENT_PREVIEW_LIMITS[format]) throw new DocumentPreviewError("size");
                const bytes = await response.arrayBuffer();
                if (bytes.byteLength > DOCUMENT_PREVIEW_LIMITS[format]) throw new DocumentPreviewError("size");
                const result = await loadDocument(format, bytes, controller.signal);
                if (!controller.signal.aborted) setLoaded(result);
            } catch (cause) {
                if (!controller.signal.aborted) setError(documentPreviewErrorMessage(cause, tr) ?? errorMessage(cause));
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        })();
        return () => controller.abort();
    }, [endpoint, entry.path, entry.modifiedAt, entry.size, format, retry, tr]);
    if (!format) return null;
    if (entry.size > DOCUMENT_PREVIEW_LIMITS[format]) return <div className="file-download-preview"><h3>{tr("文件过大，无法在这里预览", "File is too large to preview here")}</h3><p>{tr(`预览上限为 ${formatFileSize(DOCUMENT_PREVIEW_LIMITS[format])}，可下载原文件。`, `Preview limit is ${formatFileSize(DOCUMENT_PREVIEW_LIMITS[format])}; download the original file.`)}</p></div>;
    if (loading) return <div className="document-loading" role="status">{tr("正在读取文件…", "Reading file…")}</div>;
    if (error) return <div className="document-error" role="alert"><p>{error}</p><button className="button button-small button-secondary" onClick={() => setRetry(value => value + 1)}>{tr("重试预览", "Retry preview")}</button></div>;
    if (!loaded) return null;
    if (loaded.kind === "pdf") return <PdfPages key={`${entry.path}-${entry.modifiedAt}`} bytes={loaded.bytes}/>;
    if (loaded.kind === "docx") return <div className="document-scroll"><article className="docx-document" dangerouslySetInnerHTML={{ __html: loaded.html }}/></div>;
    return <SpreadsheetPreview sheets={loaded.sheets}/>;
}

function PdfPages({ bytes }: { bytes: Uint8Array }) {
    const { tr } = useLocale();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const documentRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(null);
    const [pages, setPages] = useState(0);
    const [pageNumber, setPageNumber] = useState(1);
    const [zoom, setZoom] = useState(1);
    const [query, setQuery] = useState("");
    const [match, setMatch] = useState("");
    const [error, setError] = useState("");
    const [rendering, setRendering] = useState(false);
    const searchRun = useRef(0);
    useEffect(() => () => { searchRun.current++; }, []);
    useEffect(() => {
        let disposed = false;
        let task: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
        void (async () => {
            try {
                const pdfjs = await import("pdfjs-dist");
                pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
                task = pdfjs.getDocument({ data: bytes });
                const document = await task.promise;
                if (disposed) { await task.destroy(); return; }
                documentRef.current = document;
                setPages(document.numPages);
            } catch { if (!disposed) setError(tr("无法预览此文件，可能已损坏或格式不受支持。可下载原文件。", "This file cannot be previewed. It may be damaged or unsupported. Download the original file.")); }
        })();
        return () => { disposed = true; documentRef.current = null; void task?.destroy(); };
    }, [bytes]);
    useEffect(() => {
        if (!pages || !documentRef.current || !canvasRef.current) return;
        let disposed = false;
        let renderTask: import("pdfjs-dist").RenderTask | null = null;
        const canvas = canvasRef.current;
        setRendering(true);
        void (async () => {
            try {
                const page = await documentRef.current!.getPage(pageNumber);
                if (disposed) return;
                const viewport = page.getViewport({ scale: zoom * 1.25 });
                const ratio = Math.min(window.devicePixelRatio || 1, 2);
                const pixels = Math.min(ratio, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
                canvas.width = Math.floor(viewport.width * pixels);
                canvas.height = Math.floor(viewport.height * pixels);
                canvas.style.width = `${Math.round(viewport.width)}px`;
                canvas.style.height = `${Math.round(viewport.height)}px`;
                const context = canvas.getContext("2d");
                if (!context) throw new Error("Canvas unavailable");
                renderTask = page.render({ canvas, canvasContext: context, viewport, transform: [pixels, 0, 0, pixels, 0, 0] });
                await renderTask.promise;
                if (!disposed) setError("");
            } catch (cause) { if (!disposed && !(cause instanceof Error && cause.name === "RenderingCancelledException")) setError(tr("无法渲染此页。可下载原文件。", "This page could not be rendered. Download the original file.")); }
            finally { if (!disposed) setRendering(false); }
        })();
        return () => { disposed = true; renderTask?.cancel(); };
    }, [pageNumber, pages, zoom]);
    async function search() {
        const term = query.trim().toLocaleLowerCase();
        if (!term || !documentRef.current) return;
        setMatch(tr("正在查找…", "Searching…"));
        const document = documentRef.current;
        const run = ++searchRun.current;
        try {
            const limit = Math.min(document.numPages, 1000);
            for (let step = 0; step < limit; step++) {
                if (run !== searchRun.current) return;
                const index = ((pageNumber - 1 + step) % limit) + 1;
                const page = await document.getPage(index);
                const content = await page.getTextContent();
                if (run !== searchRun.current) return;
                const text = content.items.map(item => "str" in item ? item.str : "").join(" ");
                const at = text.toLocaleLowerCase().indexOf(term);
                if (at !== -1) {
                    setPageNumber(index);
                    setMatch(tr(`第 ${index} 页：…${text.slice(Math.max(0, at - 25), at + term.length + 45)}…`, `Page ${index}: …${text.slice(Math.max(0, at - 25), at + term.length + 45)}…`));
                    return;
                }
            }
            setMatch(tr("未找到匹配内容。", "No matching text found."));
        } catch (cause) {
            if (run === searchRun.current) setMatch(errorMessage(cause));
        }
    }
    return <div className="pdf-preview">
        <div className="document-toolbar"><button disabled={pageNumber <= 1} onClick={() => setPageNumber(value => value - 1)} aria-label={tr("上一页", "Previous page")}>‹</button><span>{pageNumber} / {pages || "…"}</span><button disabled={pageNumber >= pages} onClick={() => setPageNumber(value => value + 1)} aria-label={tr("下一页", "Next page")}>›</button><button disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))} aria-label={tr("缩小", "Zoom out")}>−</button><span>{Math.round(zoom * 100)}%</span><button disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.25))} aria-label={tr("放大", "Zoom in")}>+</button></div>
        <form className="document-search" onSubmit={event => { event.preventDefault(); void search(); }}><input value={query} onChange={event => setQuery(event.target.value)} aria-label={tr("在 PDF 中查找", "Search in PDF")} placeholder={tr("在 PDF 中查找", "Search in PDF")}/><button className="button button-small button-secondary" disabled={!pages || !query.trim()}>{tr("查找", "Find")}</button></form>
        {match && <p className="document-match" role="status">{match}</p>}
        {error && <p className="document-error" role="alert">{error}</p>}
        <div className="pdf-canvas-scroll">{rendering && <span role="status">{tr("正在渲染页面…", "Rendering page…")}</span>}<canvas ref={canvasRef} aria-label={tr(`PDF 第 ${pageNumber} 页`, `PDF page ${pageNumber}`)}/></div>
    </div>;
}

function SpreadsheetPreview({ sheets }: { sheets: Spreadsheet[] }) {
    const { tr, locale } = useLocale();
    const [sheetIndex, setSheetIndex] = useState(0);
    const [query, setQuery] = useState("");
    const sheet = sheets[sheetIndex];
    const rows = sheet?.data ?? [];
    const term = query.trim().toLocaleLowerCase();
    const matches = useMemo(() => rows.map((row, index) => ({ row, index })).filter(({ row }) => !term || row.some(cell => readableCell(cell, locale).toLocaleLowerCase().includes(term))).slice(0, 500), [rows, term, locale]);
    const columns = Math.min(60, Math.max(1, ...matches.map(({ row }) => row.length)));
    return <div className="spreadsheet-preview">
        <div className="spreadsheet-tabs" role="tablist" aria-label={tr("工作表", "Worksheets")}>{sheets.map((item, index) => <button key={`${item.sheet}-${index}`} role="tab" aria-selected={index === sheetIndex} className={index === sheetIndex ? "active" : ""} onClick={() => { setSheetIndex(index); setQuery(""); }}>{item.sheet}</button>)}</div>
        <label className="document-search"><span>{tr("查找", "Find")}</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={tr("搜索当前工作表", "Search current sheet")}/></label>
        <p className="spreadsheet-count">{tr(`显示 ${matches.length} / ${sheet?.totalRows ?? 0} 行${(sheet?.totalRows ?? 0) > rows.length ? "（仅搜索前 5000 行）" : ""}`, `Showing ${matches.length} of ${sheet?.totalRows ?? 0} rows${(sheet?.totalRows ?? 0) > rows.length ? " (searching first 5000 rows)" : ""}`)}</p>
        <div className="spreadsheet-scroll"><table><thead><tr><th scope="col">#</th>{Array.from({ length: columns }, (_, index) => <th scope="col" key={index}>{index < 26 ? String.fromCharCode(65 + index) : `${String.fromCharCode(64 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`}</th>)}</tr></thead><tbody>{matches.map(({ row, index }) => <tr key={index}><th scope="row">{index + 1}</th>{Array.from({ length: columns }, (_, column) => <td key={column} title={readableCell(row[column], locale)}>{readableCell(row[column], locale).slice(0, 500)}</td>)}</tr>)}</tbody></table></div>
    </div>;
}
