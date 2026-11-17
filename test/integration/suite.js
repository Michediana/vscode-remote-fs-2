// Executed inside the VS Code extension host by test/integration/run.js.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { FtpSrv } = require('ftp-srv');

const quiet = { info() {}, debug() {}, trace() {}, warn() {}, error() {}, child() { return this; } };
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);

async function expectFsError(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof vscode.FileSystemError, `expected FileSystemError, got ${err}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let root, server, base;

test('extension activates and registers commands', async () => {
  const ext = vscode.extensions.getExtension('michediana.remotefs-2');
  assert.ok(ext, 'extension found');
  await ext.activate();
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['remotefs.addConnection', 'remotefs.editConnection', 'remotefs.addFolderToWorkspace', 'remotefs.refresh']) {
    assert.ok(cmds.includes(c), c);
  }
});

test('connections view can be shown', async () => {
  await vscode.commands.executeCommand('workbench.view.extension.remotefs');
});

test('write / read / stat / readDirectory', async () => {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(base, 'dir'));
  const file = vscode.Uri.joinPath(base, 'dir/hello.txt');
  await vscode.workspace.fs.writeFile(file, enc('ciao'));
  assert.equal(fs.readFileSync(path.join(root, 'www/dir/hello.txt'), 'utf8'), 'ciao', 'rootPath applied');
  assert.equal(dec(await vscode.workspace.fs.readFile(file)), 'ciao');
  const st = await vscode.workspace.fs.stat(file);
  assert.equal(st.type, vscode.FileType.File);
  assert.equal(st.size, 4);
  const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(base, 'dir'));
  assert.deepEqual(entries, [['hello.txt', vscode.FileType.File]]);
});

test('errors are proper FileSystemErrors', async () => {
  await expectFsError(vscode.workspace.fs.stat(vscode.Uri.joinPath(base, 'nope')), 'FileNotFound');
  await expectFsError(vscode.workspace.fs.readFile(vscode.Uri.joinPath(base, 'nope')), 'FileNotFound');
  // workspace.fs.createDirectory has mkdirp semantics, so an existing dir is not an error there
  await expectFsError(vscode.workspace.fs.stat(vscode.Uri.parse('ftp://unknown-remote/')), 'Unavailable');
});

test('rename respects overwrite flag', async () => {
  const a = vscode.Uri.joinPath(base, 'dir/a.txt');
  const b = vscode.Uri.joinPath(base, 'dir/hello.txt');
  await vscode.workspace.fs.writeFile(a, enc('A'));
  await expectFsError(vscode.workspace.fs.rename(a, b, { overwrite: false }), 'FileExists');
  await vscode.workspace.fs.rename(a, b, { overwrite: true });
  assert.equal(dec(await vscode.workspace.fs.readFile(b)), 'A');
});

test('open a remote file in an editor and save it', async () => {
  const uri = vscode.Uri.joinPath(base, 'dir/hello.txt');
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit(e => e.insert(new vscode.Position(0, 0), 'edited '));
  assert.ok(await doc.save(), 'saved');
  assert.equal(fs.readFileSync(path.join(root, 'www/dir/hello.txt'), 'utf8'), 'edited A');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('recursive delete', async () => {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(base, 'dir/sub'));
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(base, 'dir/sub/x'), enc('x'));
  await vscode.workspace.fs.delete(vscode.Uri.joinPath(base, 'dir'), { recursive: true, useTrash: false });
  assert.equal(fs.existsSync(path.join(root, 'www/dir')), false);
});

test('settings change closes the connection and the new config is used', async () => {
  const cfg = vscode.workspace.getConfiguration('remotefs');
  const remote = { ...cfg.get('remote') };
  remote.Test = { ...remote.Test, rootPath: '/' };
  await cfg.update('remote', remote, vscode.ConfigurationTarget.Global);
  await new Promise(r => setTimeout(r, 200));
  const entries = await vscode.workspace.fs.readDirectory(base);
  assert.deepEqual(entries.map(e => e[0]), ['www']);
});

exports.run = async function run() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotefs-it-'));
  fs.mkdirSync(path.join(root, 'www'));
  server = new FtpSrv({ url: 'ftp://127.0.0.1:2121', pasv_url: '127.0.0.1', pasv_min: 41000, pasv_max: 41100, log: quiet });
  server.on('login', ({ username, password }, resolve, reject) =>
    username === 'user' && password === 'secret' ? resolve({ root }) : reject(new Error('bad login'))
  );
  await server.listen();
  await vscode.workspace.getConfiguration('remotefs').update(
    'remote',
    { Test: { scheme: 'ftp', host: '127.0.0.1', port: 2121, username: 'user', password: 'secret', rootPath: '/www' } },
    vscode.ConfigurationTarget.Global
  );
  // URIs are case-insensitive on the connection name: "Test" is addressed as "test"
  base = vscode.Uri.parse('ftp://test/');

  let failed = 0;
  try {
    for (const t of tests) {
      try {
        await t.fn();
        console.log(`  ✔ ${t.name}`);
      } catch (err) {
        failed++;
        console.log(`  ✖ ${t.name}\n    ${err && err.stack}`);
      }
    }
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`${tests.length - failed}/${tests.length} integration tests passed`);
  if (failed) {
    throw new Error(`${failed} integration test(s) failed`);
  }
};
