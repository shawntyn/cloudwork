import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listFiles, readFileContent, writeFileContent, makeDirectory, renameEntry, deleteEntry, relativeParts, validateId, workspacePath } from '../packages/workspace/src/index.ts';

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
    await assert.rejects(writeFileContent(root,'big.txt','x'.repeat(2097153)));
    await writeFile(path.join(root,'binary.bin'),Buffer.from([0,1,2]));
    await assert.rejects(readFileContent(root,'binary.bin'));
    await deleteEntry(root,'src');
    await assert.rejects(readFileContent(root,'src/b.ts'));
  } finally { await rm(base,{recursive:true,force:true}); }
});
