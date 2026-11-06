import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { db, workspaces } from '@cloud-work/database';
import type { RuntimeManager } from '../src/lifecycle.js';
import { reconcileTrashedWorkspace } from '../src/workspace-trash.js';
import { moveWorkspaceStorage, purgeWorkspaceStorage } from '../src/workspace-trash-storage.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cloud-work-trash-')));
  const active = path.join(root, 'user_a', 'workspaces');
  const trash = path.join(root, 'user_a', 'trash');
  await mkdir(path.join(active, 'ws_one'), { recursive: true });
  await writeFile(path.join(active, 'ws_one', 'keep.txt'), 'original file');
  return { root, active, trash, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('Trash moves files outside the Runtime workspaces bind and restore returns original bytes', async () => {
  const data = await fixture();
  try {
    assert.equal(await moveWorkspaceStorage(data.root, 'user_a', 'ws_one', 'trash'), true);
    assert.deepEqual(await readdir(data.active), []);
    assert.equal(await readFile(path.join(data.trash, 'ws_one', 'keep.txt'), 'utf8'), 'original file');
    assert.equal(await moveWorkspaceStorage(data.root, 'user_a', 'ws_one', 'trash'), false);
    assert.equal(await moveWorkspaceStorage(data.root, 'user_a', 'ws_one', 'restore'), true);
    // If restoration stops before the database update, the sweep can move it
    // back to Trash and a retry still returns the same files.
    assert.equal(await moveWorkspaceStorage(data.root, 'user_a', 'ws_one', 'trash'), true);
    assert.equal(await moveWorkspaceStorage(data.root, 'user_a', 'ws_one', 'restore'), true);
    assert.equal(await readFile(path.join(data.active, 'ws_one', 'keep.txt'), 'utf8'), 'original file');
    assert.equal(await moveWorkspaceStorage(data.root, 'user_a', 'ws_one', 'restore'), false);
  } finally { await data.cleanup(); }
});

test('purge finishes an interrupted move and removes only the intended workspace', async () => {
  const data = await fixture();
  try {
    await mkdir(path.join(data.active, 'ws_other'));
    await writeFile(path.join(data.active, 'ws_other', 'untouched.txt'), 'another workspace');
    await purgeWorkspaceStorage(data.root, 'user_a', 'ws_one');
    assert.deepEqual(await readdir(data.trash), []);
    assert.equal(await readFile(path.join(data.active, 'ws_other', 'untouched.txt'), 'utf8'), 'another workspace');
    await purgeWorkspaceStorage(data.root, 'user_a', 'ws_one');
  } finally { await data.cleanup(); }
});

test('symlink or two competing directories stop relocation without deleting either target', async () => {
  const data = await fixture();
  try {
    await mkdir(data.trash);
    await mkdir(path.join(data.trash, 'ws_one'));
    await assert.rejects(moveWorkspaceStorage(data.root, 'user_a', 'ws_one', 'trash'), /both active and trash/);
    assert.equal(await readFile(path.join(data.active, 'ws_one', 'keep.txt'), 'utf8'), 'original file');
    await rm(path.join(data.trash, 'ws_one'), { recursive: true });
    await symlink(data.active, path.join(data.trash, 'ws_one'));
    await assert.rejects(purgeWorkspaceStorage(data.root, 'user_a', 'ws_one'), /real directory/);
    assert.equal(await readFile(path.join(data.active, 'ws_one', 'keep.txt'), 'utf8'), 'original file');
  } finally { await data.cleanup(); }
});

test('Trash reconciliation does not re-trash a workspace restored after the reaper scan', async t => {
  const data = await fixture();
  try {
    await mkdir(data.trash);
    let updates = 0;
    t.mock.method(db, 'select', () => ({ from(table: unknown) {
      assert.equal(table, workspaces);
      return { where() { return { async limit() {
        return [{ id: 'ws_one', userId: 'user_a', deletedAt: null }];
      } }; } };
    } }) as never);
    t.mock.method(db, 'update', () => { updates++; throw new Error('Reconciliation must not update the tombstone'); });
    const manager = {
      config: { dataRoot: data.root },
      leases: { async withLock(_key: string, work: () => Promise<unknown>) { return work(); } },
    } as unknown as RuntimeManager;
    await reconcileTrashedWorkspace(manager, 'user_a', 'ws_one');
    assert.equal(updates, 0);
    assert.equal(await readFile(path.join(data.active, 'ws_one', 'keep.txt'), 'utf8'), 'original file');
    assert.deepEqual(await readdir(data.trash), []);
  } finally { await data.cleanup(); }
});
