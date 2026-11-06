type ParseRequest = { kind: "docx" | "xlsx"; bytes: ArrayBuffer };
class PreviewLimitError extends Error {}

self.onmessage = (event: MessageEvent<ParseRequest>) => {
    void (async () => {
        try {
            if (event.data.kind === "docx") {
                const module = await import("mammoth");
                const mammoth = module.default ?? module;
                const result = await mammoth.convertToHtml({ arrayBuffer: event.data.bytes }, { externalFileAccess: false });
                if (result.value.length > 6_000_000) throw new PreviewLimitError("Document preview is too large");
                self.postMessage({ kind: "docx", html: result.value });
            } else {
                const module = await import("read-excel-file/web-worker");
                const sheets = await module.default(event.data.bytes);
                if (sheets.length > 100) throw new PreviewLimitError("Workbook has too many sheets to preview");
                let cells = 0;
                const limited = sheets.map(sheet => {
                    const data = sheet.data.slice(0, 5000).map(row => {
                        cells += row.length;
                        if (cells > 100_000) throw new PreviewLimitError("Workbook has too many cells to preview");
                        return row.slice(0, 60);
                    });
                    return { sheet: sheet.sheet, data, totalRows: sheet.data.length };
                });
                self.postMessage({ kind: "xlsx", sheets: limited });
            }
        } catch (cause) {
            self.postMessage({ error: cause instanceof Error ? cause.message : "Document could not be read", reason: cause instanceof PreviewLimitError ? "size" : "parse" });
        }
    })();
};
