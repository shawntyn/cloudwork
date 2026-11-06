import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listFiles, searchFiles, readFileContent, readFileWithVersion, writeFileContent, makeDirectory, renameEntry, deleteEntry, relativeParts, validateId, workspacePath } from '../packages/workspace/src/index.ts';

test('identifiers and traversal inputs are rejected', () => {
  for (const bad of ['../secret','a/../../x','/etc/passwd','a\\..\\secret','a\0b']) assert.throws(() => relativeParts(bad));
  for (const bad of ['../../x','a/b','','x;echo hi','x'.repeat(101)]) assert.throws(() => validateId(bad));
  assert.equal(workspacePath('ws_abc-123'),'/home/work/workspaces/ws_abc-123');
  assert.throws(() => relativeParts(''));
});

test('POSIX file workflow and symlink escape defenses', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(),'cloud-work-fs-')));
  const root = path.join(base,'workspace'), outside = path.join(base,'outside');
  await mkdir(root); await mkdir(outside); await writeFile(path.join(outside,'secret'),'private');
  try {
    await makeDirectory(root,'src');
    await writeFileContent(root,'src/a.ts','export const answer = 42;');
    assert.equal(await readFileContent(root,'src/a.ts'),'export const answer = 42;');
    assert.deepEqual((await listFiles(root)).map(f => [f.name,f.type]),[['src','directory']]);
    await renameEntry(root,'src/a.ts','src/b.ts');
    await assert.rejects(readFileContent(root,'src/a.ts'));
    await symlink(outside,path.join(root,'escape'));
    await symlink(path.join(outside,'secret'),path.join(root,'secret-link'));
    await assert.rejects(readFileContent(root,'escape/secret'));
    await assert.rejects(readFileContent(root,'secret-link'));
    await assert.rejects(writeFileContent(root,'escape/secret','overwrite'));
    await assert.rejects(writeFileContent(root,'secret-link','overwrite'));
    await assert.rejects(makeDirectory(root,'escape/created'));
    await assert.rejects(renameEntry(root,'src/b.ts','escape/moved'));
    await assert.rejects(deleteEntry(root,'escape/secret'));
    await deleteEntry(root,'escape'); // Unlinking the link must not remove its target.
    assert.equal(await readFile(path.join(outside,'secret'),'utf8'),'private');
    await assert.rejects(deleteEntry(root,''));
    await assert.rejects(writeFileContent(root,'big.txt','x'.repeat(10 * 1024 * 1024 + 1)));
    await writeFile(path.join(root,'binary.bin'),Buffer.from([0,1,2]));
    await assert.rejects(readFileContent(root,'binary.bin'));
    await writeFile(path.join(root,'invalid-utf8.bin'),Buffer.from([0xff,0xfe,0x41]));
    await assert.rejects(readFileContent(root,'invalid-utf8.bin'), /UTF-8/);
    await writeFileContent(root,'unicode.txt','\ufeff中文内容');
    assert.equal(await readFileContent(root,'unicode.txt'),'\ufeff中文内容');
    const largeText = 'x'.repeat(3 * 1024 * 1024);
    await writeFileContent(root,'larger.txt',largeText);
    assert.equal(await readFileContent(root,'larger.txt'),largeText);
    await deleteEntry(root,'src');
    await assert.rejects(readFileContent(root,'src/b.ts'));
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('file versions prevent overwriting a changed draft and bounded search skips symlinks', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cloud-work-version-')));
  const root = path.join(base, 'workspace'), outside = path.join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  try {
    await makeDirectory(root, 'notes');
    await writeFileContent(root, 'notes/plan.md', '# First');
    const opened = await readFileWithVersion(root, 'notes/plan.md');
    assert.match(opened.version, /^[a-f0-9]{64}$/);
    assert.equal((await listFiles(root, 'notes'))[0]?.modifiedAt > 0, true);
    await writeFileContent(root, 'notes/plan.md', '# Changed by agent');
    await assert.rejects(writeFileContent(root, 'notes/plan.md', '# Stale draft', opened.version), /changed since it was opened/);
    assert.equal(await readFileContent(root, 'notes/plan.md'), '# Changed by agent');
    const latest = await readFileWithVersion(root, 'notes/plan.md');
    const savedVersion = await writeFileContent(root, 'notes/plan.md', '# Reviewed draft', latest.version);
    assert.notEqual(savedVersion, latest.version);
    await symlink(outside, path.join(root, 'outside-link'));
    const result = await searchFiles(root, 'plan');
    assert.deepEqual(result.entries.map(entry => entry.path), ['notes/plan.md']);
    assert.equal(result.truncated, false);
    assert.deepEqual((await searchFiles(root, 'outside')).entries.map(entry => entry.path), ['outside-link']);
  } finally { await rm(base, { recursive: true, force: true }); }
});
