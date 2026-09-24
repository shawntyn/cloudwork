"use client";

import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes } from "prism-react-renderer";
import { useLocale } from "./locale";

const MAX_HIGHLIGHT_CHARS = 1_000_000;

export function languageFromFilename(filename: string): string {
    const extension = filename.split(".").pop()?.toLowerCase() || "";
    return ({
        bash: "bash", c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css", go: "go",
        h: "c", hpp: "cpp", html: "markup", htm: "markup", java: "java", js: "javascript",
        json: "json", jsx: "jsx", md: "markdown", mjs: "javascript", py: "python",
        rb: "ruby", rs: "rust", scss: "scss", sh: "bash", sql: "sql", svg: "markup",
        ts: "typescript", tsx: "tsx", txt: "text", vue: "markup", xml: "markup",
        yaml: "yaml", yml: "yaml",
    } as Record<string, string>)[extension] || "text";
}

function languageLabel(language: string, tr: (zh: string, en: string) => string) {
    return ({
        bash: "Shell", c: "C", cpp: "C++", csharp: "C#", css: "CSS", go: "Go",
        java: "Java", javascript: "JavaScript", json: "JSON", jsx: "JSX",
        markdown: "Markdown", markup: "HTML/XML", python: "Python", rust: "Rust",
        sql: "SQL", text: tr("纯文本", "Plain text"), tsx: "TSX", typescript: "TypeScript",
        yaml: "YAML",
    } as Record<string, string>)[language] || language.toUpperCase();
}

function allowedLink(href: string | undefined): string | null {
    if (!href) return null;
    if (href.startsWith("#")) return href;
    try {
        const url = new URL(href);
        return ["http:", "https:", "mailto:"].includes(url.protocol) ? href : null;
    } catch {
        return null;
    }
}

export function CodeViewer({ code, language = "text", filename, variant = "file" }: {
    code: string;
    language?: string;
    filename?: string;
    variant?: "chat" | "file";
}) {
    const { theme, tr } = useLocale();
    const [systemDark, setSystemDark] = useState(false);
    const [query, setQuery] = useState("");
    const [activeMatch, setActiveMatch] = useState(0);
    const [wrap, setWrap] = useState(false);
    const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
    const lineRefs = useRef<Array<HTMLSpanElement | null>>([]);
    const visibleCode = code.length > MAX_HIGHLIGHT_CHARS ? code.slice(0, MAX_HIGHLIGHT_CHARS) : code;
    const truncated = visibleCode.length !== code.length;
    const lineTexts = useMemo(() => visibleCode.split("\n"), [visibleCode]);
    const matches = useMemo(() => {
        const term = query.trim().toLocaleLowerCase();
        return term ? lineTexts.flatMap((line, index) => line.toLocaleLowerCase().includes(term) ? [index] : []) : [];
    }, [lineTexts, query]);
    const matchSet = useMemo(() => new Set(matches), [matches]);
    const activeLine = matches.length ? matches[activeMatch % matches.length] : -1;
    const dark = theme === "dark" || (theme === "system" && systemDark);

    useEffect(() => {
        if (theme !== "system") return;
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const update = () => setSystemDark(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, [theme]);
    useEffect(() => { setActiveMatch(0); }, [query]);
    useEffect(() => { if (activeLine >= 0) lineRefs.current[activeLine]?.scrollIntoView({ block: "center" }); }, [activeLine]);
    useEffect(() => {
        if (copyStatus === "idle") return;
        const timer = window.setTimeout(() => setCopyStatus("idle"), 2200);
        return () => window.clearTimeout(timer);
    }, [copyStatus]);

    async function copy() {
        try {
            await navigator.clipboard.writeText(code);
            setCopyStatus("copied");
        } catch {
            setCopyStatus("failed");
        }
    }

    return <div className={`code-viewer code-viewer-${variant}${wrap ? " is-wrapped" : ""}`}>
        <div className="code-viewer-toolbar">
            <span className="code-viewer-name" title={filename || language}>{variant === "file" ? languageLabel(language, tr) : filename || language || tr("代码", "Code")}</span>
            {variant === "file" && <>
                <label className="code-viewer-search"><span className="sr-only">{tr("查找代码", "Find in code")}</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={tr("查找", "Find")}/></label>
                {query && <span className="code-viewer-count" aria-live="polite">{matches.length ? `${activeMatch % matches.length + 1}/${matches.length}` : tr("无结果", "No matches")}</span>}
                {matches.length > 0 && <div className="code-viewer-find-actions"><button type="button" onClick={() => setActiveMatch(value => (value - 1 + matches.length) % matches.length)} aria-label={tr("上一个匹配", "Previous match")}>↑</button><button type="button" onClick={() => setActiveMatch(value => (value + 1) % matches.length)} aria-label={tr("下一个匹配", "Next match")}>↓</button></div>}
                <button type="button" className="code-viewer-action" onClick={() => setWrap(value => !value)} aria-pressed={wrap}>{wrap ? tr("不折行", "No wrap") : tr("折行", "Wrap")}</button>
            </>}
            <button type="button" className="code-viewer-action" onClick={() => void copy()} aria-label={tr("复制代码", "Copy code")}>{copyStatus === "copied" ? tr("已复制", "Copied") : copyStatus === "failed" ? tr("复制失败", "Copy failed") : tr("复制", "Copy")}</button>
        </div>
        <div className="code-viewer-scroll" role="region" aria-label={filename ? tr("代码预览：", "Code preview: ") + filename : tr("代码块", "Code block")} tabIndex={0}>
            <Highlight theme={dark ? themes.vsDark : themes.vsLight} code={visibleCode} language={language}>
                {({ tokens, getLineProps, getTokenProps }) => <pre><code>{tokens.map((line, index) => {
                    const lineProps = getLineProps({ line });
                    return <span key={index} {...lineProps} ref={element => { lineRefs.current[index] = element; }} className={`code-viewer-line${matchSet.has(index) ? " is-match" : ""}${index === activeLine ? " is-active-match" : ""}`}>
                        <span className="code-viewer-line-number" aria-hidden="true">{index + 1}</span>
                        <span className="code-viewer-line-content">{line.map((token, tokenIndex) => <span key={tokenIndex} {...getTokenProps({ token })}/>)}{line.length === 0 && "\u200b"}</span>
                    </span>;
                })}</code></pre>}
            </Highlight>
        </div>
        {truncated && <p className="code-viewer-truncated">{tr("文件较大，仅高亮显示前 100 万个字符。完整内容可下载。", "This file is large. Highlighting shows the first 1 million characters; download for the full content.")}</p>}
    </div>;
}

export function RichContent({ content, variant = "chat" }: { content: string; variant?: "chat" | "file" }) {
    const { tr } = useLocale();
    return <div className={`rich-content rich-content-${variant}`}>
        <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
            pre({ children }) {
                const child = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
                const language = /language-([\w#+-]+)/.exec(child?.props.className || "")?.[1] || "text";
                return <CodeViewer code={String(child?.props.children ?? "").replace(/\n$/, "")} language={language} variant="chat"/>;
            },
            code({ children, className }) { return <code className={className}>{children}</code>; },
            table({ children }) { return <div className="rich-table-scroll" role="region" aria-label={tr("表格", "Table")} tabIndex={0}><table>{children}</table></div>; },
            a({ children, href }) {
                const safeHref = allowedLink(href);
                return safeHref ? <a href={safeHref} target={safeHref.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">{children}</a> : <span className="rich-inert-link" title={href}>{children}</span>;
            },
            img({ alt, title }) { return <span className="rich-image-placeholder" title={title}>{tr("图片：", "Image: ")}{alt || tr("未命名", "Untitled")}</span>; },
        }}>{content}</Markdown>
    </div>;
}
