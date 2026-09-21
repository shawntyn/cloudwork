import test from "node:test";
import assert from "node:assert/strict";
import { FILE_TRANSFER_LIMITS } from "@cloud-work/protocol";
import { downloadUrl, droppedFiles, isSafeImageFile, isTextFile, prepareUploadSelection } from "./file-transfer";

const file = (name: string, size = 1) => ({ name, size } as File);
test("upload manifests preserve nested paths and empty folders under the selected destination", () => {
    const input = { path: "project/src/main.ts", file: file("main.ts", 12) };
    const selection = prepareUploadSelection([input], ["project", "project/empty"], "target");
    assert.equal(selection.files[0]!.path, "target/project/src/main.ts");
    assert.equal(selection.files[0]!.file, input.file);
    assert.deepEqual(new Set(selection.directories), new Set(["target", "target/project", "target/project/empty", "target/project/src"]));
    assert.deepEqual(prepareUploadSelection([], ["empty"], "").directories, ["empty"]);
});

test("upload limits and unsafe or ambiguous paths fail before creating a batch", () => {
    for (const path of ["../escape", "nested/../escape", "/absolute", "a\\b", "a//b", "a/./b", "bad\0file"]) {
        assert.throws(() => prepareUploadSelection([{ path, file: file("x") }], [], ""), /unsafe/);
    }
    assert.throws(() => prepareUploadSelection([{ path: "a", file: file("a") }, { path: "a", file: file("a") }], [], ""), /duplicate/);
    assert.throws(() => prepareUploadSelection([{ path: "a", file: file("a") }, { path: "a/b", file: file("b") }], [], ""), /same path/);
    assert.throws(() => prepareUploadSelection([{ path: "a", file: file("a") }], ["a"], ""), /duplicate/);
    assert.throws(() => prepareUploadSelection([{ path: "huge", file: file("huge", FILE_TRANSFER_LIMITS.maxFileBytes + 1) }], [], ""), /file limit/);
    assert.throws(() => prepareUploadSelection(Array.from({ length: 11 }, (_, index) => ({ path: String(index), file: file(String(index), FILE_TRANSFER_LIMITS.maxFileBytes) })), [], ""), /batches/);
    assert.throws(() => prepareUploadSelection([], Array.from({ length: FILE_TRANSFER_LIMITS.maxEntries + 1 }, (_, index) => String(index)), ""), /files and folders/);
    assert.throws(() => prepareUploadSelection([], [], ""), /No files/);
});

test("directory drops drain paginated readers and retain empty directories", async () => {
    const text = file("notes.txt", 7);
    const entry = { name: "notes.txt", isFile: true, isDirectory: false, file: (done: (value: File) => void) => done(text) } as FileSystemFileEntry;
    function folder(name: string, pages: FileSystemEntry[][]): FileSystemDirectoryEntry {
        return { name, isFile: false, isDirectory: true, createReader: () => {
            let page = 0;
            return { readEntries: (done: (entries: FileSystemEntry[]) => void) => done(pages[page++] ?? []) };
        } } as FileSystemDirectoryEntry;
    }
    const root = folder("project", [[folder("empty", [])], [entry]]);
    const selection = await droppedFiles([{ kind: "file", webkitGetAsEntry: () => root } as unknown as DataTransferItem], []);
    assert.deepEqual(selection.directories, ["project", "project/empty"]);
    assert.deepEqual(selection.files, [{ path: "project/notes.txt", file: text }]);
    assert.deepEqual(await droppedFiles([{ kind: "file" } as DataTransferItem], [text]), { files: [{ path: "notes.txt", file: text }], directories: [] });
});

test("downloads use encoded paths and preview classification never embeds SVG or Office documents", () => {
    assert.equal(downloadUrl("/files", "folder/a #?.txt"), "/files/download?path=folder%2Fa+%23%3F.txt");
    assert.equal(downloadUrl("/files", "", true), "/files/download?path=&archive=1");
    for (const name of ["README.md", "data.csv", ".env.local", "Dockerfile", "src/app.tsx", "README", "LICENSE", "scripts/run", "notes", "a", "o", "doc", "key", "custom/report.mytext", ".custom-config"]) {
        assert.equal(isTextFile(name), true, `${name} must retain the Runtime UTF-8 read path`);
    }
    for (const name of ["report.pdf", "report.doc", "report.docx", "report.xlsx", "report.xls", "slides.pptx", "document.rtf", "archive.zip", "payload.svg", "photo.heic", "audio.mp3", "database.sqlite", "module.wasm"]) {
        assert.equal(isSafeImageFile(name), false);
        assert.equal(isTextFile(name), false);
    }
    for (const name of ["photo.PNG", "photo.jpeg", "animated.gif", "photo.webp"]) {
        assert.equal(isSafeImageFile(name), true);
        assert.equal(isTextFile(name), false);
    }
});
