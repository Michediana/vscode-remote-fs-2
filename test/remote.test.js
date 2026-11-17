// Integration tests of the protocol layer (out/remote) against in-process servers.
// Run with: npm test
'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const { openClient, removeRecursive } = require('../out/remote');
const { startSftpServer } = require('./helpers/sftpServer');

const noPrompt = { prompt: async () => undefined, verifyHostKey: async () => true };

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startFtpServer(root) {
  const { FtpSrv } = require('ftp-srv');
  const port = await freePort();
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: '127.0.0.1',
    pasv_min: 40000,
    pasv_max: 40100,
    anonymous: false,
    greeting: 'test',
    log: { info() {}, debug() {}, trace() {}, warn() {}, error() {}, child() { return this; } },
  });
  server.on('login', ({ username, password }, resolve, reject) => {
    if (username === 'user' && password === 'secret') {
      resolve({ root });
    } else {
      reject(new Error('Invalid credentials'));
    }
  });
  await server.listen();
  return { port, close: () => server.close() };
}

const binary = Uint8Array.from({ length: 70000 }, (_, i) => i % 256);

function suite(scheme, start) {
  describe(scheme, () => {
    let root, server, client;
    const conn = extra => ({
      scheme,
      host: '127.0.0.1',
      port: server.port,
      username: 'user',
      password: 'secret',
      connectTimeout: 5000,
      ...extra,
    });

    before(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), `remotefs-${scheme}-`));
      server = await start(root);
      client = await openClient(conn(), noPrompt);
    });

    after(async () => {
      client?.close();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    });

    test('wrong password is reported as EAUTH', async () => {
      await assert.rejects(openClient(conn({ password: 'nope' }), noPrompt), { code: 'EAUTH' });
    });

    test('unreachable host is reported as ECONN', async () => {
      const port = await freePort();
      await assert.rejects(openClient(conn({ port }), noPrompt), { code: 'ECONN' });
    });

    test('mkdir / EEXIST', async () => {
      await client.mkdir('/dir');
      assert.ok(fs.statSync(path.join(root, 'dir')).isDirectory());
      await assert.rejects(client.mkdir('/dir'), { code: 'EEXIST' });
      await assert.rejects(client.mkdir('/missing/child'), err => err.code !== 'EEXIST');
    });

    test('write + read binary file', async () => {
      await client.writeFile('/dir/a.bin', binary);
      const back = await client.readFile('/dir/a.bin');
      assert.equal(back.length, binary.length);
      assert.deepEqual(Buffer.from(back), Buffer.from(binary));
      // overwrite with shorter content truncates
      await client.writeFile('/dir/a.bin', new TextEncoder().encode('short'));
      assert.equal(Buffer.from(await client.readFile('/dir/a.bin')).toString(), 'short');
    });

    test('stat and readdir', async () => {
      const st = await client.stat('/dir/a.bin');
      assert.equal(st.kind, 'file');
      assert.equal(st.size, 5);
      assert.equal(st.isSymlink, false);
      assert.ok(st.mtime > 0, 'mtime known');
      assert.equal((await client.stat('/dir')).kind, 'dir');
      assert.equal((await client.stat('/')).kind, 'dir');
      const entries = await client.readdir('/dir');
      assert.deepEqual(entries.map(e => [e.name, e.kind]), [['a.bin', 'file']]);
    });

    test('missing file is ENOENT', async () => {
      await assert.rejects(client.stat('/dir/nope'), { code: 'ENOENT' });
      await assert.rejects(client.readFile('/dir/nope'), { code: 'ENOENT' });
    });

    test('rename, with and without overwrite', async () => {
      await client.rename('/dir/a.bin', '/dir/b.bin', false);
      await assert.rejects(client.stat('/dir/a.bin'), { code: 'ENOENT' });
      await client.writeFile('/dir/c.bin', new TextEncoder().encode('c'));
      await client.rename('/dir/b.bin', '/dir/c.bin', true);
      assert.equal(Buffer.from(await client.readFile('/dir/c.bin')).toString(), 'short');
      assert.deepEqual((await client.readdir('/dir')).map(e => e.name), ['c.bin']);
    });

    test('parallel operations', async () => {
      const names = Array.from({ length: 8 }, (_, i) => `/dir/p${i}.txt`);
      await Promise.all(names.map(n => client.writeFile(n, new TextEncoder().encode(n))));
      const contents = await Promise.all(names.map(n => client.readFile(n)));
      contents.forEach((c, i) => assert.equal(Buffer.from(c).toString(), names[i]));
    });

    test('rmdir of non-empty dir fails, recursive delete works', async () => {
      await client.mkdir('/dir/sub');
      await client.writeFile('/dir/sub/x', new Uint8Array([1]));
      await assert.rejects(client.rmdir('/dir'));
      await removeRecursive(client, '/dir');
      assert.equal(fs.existsSync(path.join(root, 'dir')), false);
    });

    test('names with spaces and unicode', async () => {
      await client.mkdir('/spaced dir');
      await client.writeFile('/spaced dir/città è.txt', new TextEncoder().encode('ok'));
      assert.deepEqual((await client.readdir('/spaced dir')).map(e => e.name), ['città è.txt']);
      assert.equal(Buffer.from(await client.readFile('/spaced dir/città è.txt')).toString(), 'ok');
    });

    test('close marks the client closed and notifies listeners', async () => {
      const other = await openClient(conn(), noPrompt);
      let notified = false;
      other.onClose(() => (notified = true));
      other.close();
      await new Promise(r => setTimeout(r, 200));
      assert.equal(other.closed, true);
      assert.equal(notified, true);
      await assert.rejects(other.stat('/'), { code: 'ECONN' });
    });
  });
}

suite('sftp', root => startSftpServer({ root }));
suite('ftp', root => startFtpServer(root));

describe('sftp specifics', () => {
  let root, server;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotefs-sftp2-'));
    server = await startSftpServer({ root });
  });
  after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = () => ({ scheme: 'sftp', host: '127.0.0.1', port: server.port, username: 'user', connectTimeout: 5000 });

  test('host key verification: fingerprint passed, rejection cancels', async () => {
    let seen;
    const ui = { prompt: async () => undefined, verifyHostKey: async (h, p, fp) => ((seen = fp), false) };
    await assert.rejects(openClient({ ...base(), password: 'secret' }, ui), { code: 'ECANCELED' });
    assert.match(seen, /^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  test('keyboard-interactive prompts the user', async () => {
    const prompts = [];
    const ui = { prompt: async msg => (prompts.push(msg), '123456'), verifyHostKey: async () => true };
    const c = await openClient({ ...base(), interactiveAuth: true }, ui);
    assert.deepEqual(prompts, ['Verification code:']);
    c.close();
  });

  test('symlinks are resolved, dangling links are unknown', async () => {
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'broken'));
    const c = await openClient({ ...base(), password: 'secret' }, noPrompt);
    // the test server resolves link targets on the local fs, so "link" points to a real dir
    const st = await c.stat('/link');
    assert.equal(st.isSymlink, true);
    assert.equal(st.kind, 'dir');
    const entries = Object.fromEntries((await c.readdir('/')).map(e => [e.name, e]));
    assert.equal(entries.link.kind, 'dir');
    assert.equal(entries.link.isSymlink, true);
    assert.equal(entries.broken.kind, 'unknown');
    c.close();
  });

  test('writeFile preserves the mode of existing files', async () => {
    fs.writeFileSync(path.join(root, 'script.sh'), 'echo');
    fs.chmodSync(path.join(root, 'script.sh'), 0o750);
    const c = await openClient({ ...base(), password: 'secret' }, noPrompt);
    await c.writeFile('/script.sh', new TextEncoder().encode('echo hi'));
    assert.equal(fs.statSync(path.join(root, 'script.sh')).mode & 0o777, 0o750);
    c.close();
  });

  test('realpath resolves relative root paths', async () => {
    const c = await openClient({ ...base(), password: 'secret' }, noPrompt);
    assert.equal(await c.realpath('www'), '/home/www');
    c.close();
  });

  test('unreadable private key gives a clear error', async () => {
    await assert.rejects(openClient({ ...base(), privateKeyPath: '~/does-not-exist-key' }, noPrompt), {
      code: 'EAUTH',
      message: /Cannot read private key/,
    });
  });
});

describe('ftp specifics', () => {
  let root, server;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'remotefs-ftp2-'));
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'b', 'f.txt'), 'x');
    server = await startFtpServer(root);
  });
  after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // VS Code stats .vscode/settings.json & co. when a workspace opens: some servers drop the
  // control connection when asked to LIST a missing directory, so it must never be listed.
  test('stat inside a missing folder does not list it', async () => {
    const client = await openClient(
      { scheme: 'ftp', host: '127.0.0.1', port: server.port, username: 'user', password: 'secret', connectTimeout: 5000 },
      noPrompt
    );
    const listed = [];
    const list = client.ftp.list.bind(client.ftp);
    client.ftp.list = dir => (listed.push(dir), list(dir));
    try {
      await assert.rejects(client.stat('/.vscode/settings.json'), { code: 'ENOENT' });
      await assert.rejects(client.stat('/.vscode/deep/tasks.json'), { code: 'ENOENT' });
      assert.ok(!listed.some(d => d.startsWith('/.vscode')), `listed ${listed.join(', ')}`);
      assert.equal((await client.stat('/a/b/f.txt')).kind, 'file');
      await assert.rejects(client.stat('/a/b/f.txt/inside'), { code: 'ENOENT' });
      assert.ok(!listed.includes('/a/b/f.txt'), `listed ${listed.join(', ')}`);
      assert.equal(client.closed, false);
    } finally {
      client.close();
    }
  });
});
