import test from "node:test";
import assert from "node:assert/strict";
import { DocumentPreviewError, documentPreviewErrorMessage } from "./document-preview-errors";

test("document parsing failures do not expose library diagnostics in user copy", () => {
    const cause = new Error("JSZip failed; see https://example.invalid/parser-help");
    const tr = (zh: string, _en: string) => zh;
    const message = documentPreviewErrorMessage(new DocumentPreviewError("parse", cause), tr);
    assert.equal(message, "无法预览此文件，可能已损坏或格式不受支持。可下载原文件。");
    assert.equal(message?.includes("JSZip"), false);
    assert.equal(message?.includes("https://"), false);
    assert.match(documentPreviewErrorMessage(new DocumentPreviewError("timeout"), tr)!, /超时/);
    assert.match(documentPreviewErrorMessage(new DocumentPreviewError("size"), tr)!, /上限/);
});
