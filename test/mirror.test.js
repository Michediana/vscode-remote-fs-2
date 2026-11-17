// Tests of the local mirror sync engine (out/sync) and its exclude matcher.
// Run with: npm test
'use strict';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const { MirrorEngine, PLACEHOLDER_NAME, FETCH_TRIGGER, FETCH_ALL_TRIGGER } = require('../out/sync/engine');
const { compileExcludes } = require('../out/sync/glob');
const { openClient } = require('../out/remote');

/** RemoteSide backed by a local directory, counting writes. */
function dirRemote(root) {
  const abs = rel => path.join(root, ...rel.split('/').filter(Boolean));
  const remote = {
    writes: [],
    listed: [],
    async stat(rel) {
      try {
        const st = fs.statSync(abs(rel));
        return { kind: st.isDirectory() ? 'dir' : 'file', isSymlink: false, size: st.size, mtime: Math.floor(st.mtimeMs) };
      } catch {
        return undefined;
      }
    },
    async readdir(rel) {
      remote.listed.push(rel);
      return fs.readdirSync(abs(rel), { withFileTypes: true }).map(e => {
        const st = fs.statSync(path.join(abs(rel), e.name));
        return { name: e.name, kind: st.isDirectory() ? 'dir' : 'file', isSymlink: false, size: st.size, mtime: Math.floor(st.mtimeMs) };
      });
    },
    async read(rel) {
      return fs.readFileSync(abs(rel));
    },
    async write(rel, data) {
      remote.writes.push(rel);
      fs.writeFileSync(abs(rel), data);
    },
    async mkdir(rel) {
      fs.mkdirSync(abs(rel), { recursive: true });
    },
    async unlink(rel) {
      fs.unlinkSync(abs(rel));
    },
    async rmdir(rel) {
      fs.rmdirSync(abs(rel));
    },
  };
  return remote;
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

describe('exclude patterns', () => {
  test('names match at any depth, paths are anchored', () => {
    const ex = compileExcludes(['node_modules', '*.log', 'wp-content/uploads', '/cache', '**/tmp/**']);
    assert.ok(ex('node_modules'));
    assert.ok(ex('a/node_modules/x/y.js'));
    assert.ok(ex('logs/error.log'));
    assert.ok(ex('wp-content/uploads/2024/a.jpg'));
    assert.ok(!ex('x/wp-content/uploads/a.jpg'));
    assert.ok(ex('cache/a'));
    assert.ok(!ex('lib/cache.php'));
    assert.ok(ex('a/tmp/b'));
    assert.ok(!ex('index.php'));
    assert.ok(!compileExcludes([])('anything'));
  });
});

describe('MirrorEngine', () => {
  let base, local, remoteRoot, remote, engine, events;

  function makeEngine(extra = {}) {
    engine?.dispose();
    events = { conflicts: [], confirms: [] };
    engine = new MirrorEngine({
      localRoot: local,
      remote,
      manifestPath: path.join(base, 'state', 'manifest.json'),
      exclude: ['.git', 'node_modules'],
      debounce: 10,
      deleteConfirmThreshold: 5,
      listener: {
        onConflict: c => events.conflicts.push(c),
        confirmRemoteDeletes: async rels => {
          events.confirms.push(rels);
          return extra.confirm ?? true;
        },
      },
      ...extra,
    });
    return engine;
  }

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'remotefs-mirror-'));
    local = path.join(base, 'local');
    remoteRoot = path.join(base, 'remote');
    fs.mkdirSync(remoteRoot);
    write(remoteRoot, 'index.php', '<?php echo 1;');
    write(remoteRoot, 'css/site.css', 'body{}');
    write(remoteRoot, 'node_modules/x/i.js', 'ignored');
    fs.mkdirSync(path.join(remoteRoot, 'empty'));
    remote = dirRemote(remoteRoot);
    makeEngine();
  });

  afterEach(() => {
    engine?.dispose();
    engine = undefined;
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('opening downloads only the top folder; sub-folders get a placeholder', async () => {
    const r = await engine.syncAll();
    assert.deepEqual(r.downloaded, ['index.php']);
    assert.ok(exists(local, `css/${PLACEHOLDER_NAME}`));
    assert.ok(!exists(local, 'css/site.css'));
    assert.ok(exists(local, `empty/${PLACEHOLDER_NAME}`));
    assert.ok(!exists(local, 'node_modules'));
    assert.deepEqual(remote.listed, ['']);
    // second sync: lists only the folders already opened
    remote.listed.length = 0;
    const again = await engine.syncAll();
    assert.equal(again.downloaded.length + again.uploaded.length, 0);
    assert.deepEqual(remote.listed, ['']);
  });

  test('fetchDir downloads one folder and removes its placeholder', async () => {
    write(remoteRoot, 'css/vendor/lib.css', 'lib');
    await engine.syncAll();
    await engine.fetchDir('css');
    assert.equal(read(local, 'css/site.css'), 'body{}');
    assert.ok(!exists(local, `css/${PLACEHOLDER_NAME}`));
    assert.ok(exists(local, `css/vendor/${PLACEHOLDER_NAME}`), 'sub-folders stay on demand');
    assert.ok(engine.isFetched('css'));
    remote.listed.length = 0;
    await engine.syncAll();
    assert.deepEqual(remote.listed.sort(), ['', 'css']);
  });

  test('a trigger file created by an agent downloads the folder', async () => {
    write(remoteRoot, 'css/vendor/lib.css', 'lib');
    await engine.syncAll();
    write(local, `css/${FETCH_TRIGGER}`, '');
    engine.localChanged(path.join(local, 'css', FETCH_TRIGGER));
    await engine.idle();
    assert.equal(read(local, 'css/site.css'), 'body{}');
    assert.ok(!exists(local, `css/${FETCH_TRIGGER}`));
    assert.ok(!exists(local, 'css/vendor/lib.css'));

    write(local, `css/${FETCH_ALL_TRIGGER}`, '');
    engine.localChanged(path.join(local, 'css', FETCH_ALL_TRIGGER));
    await engine.idle();
    assert.equal(read(local, 'css/vendor/lib.css'), 'lib');
    assert.deepEqual(remote.writes, [], 'markers are never uploaded');
  });

  test('server changes in unopened folders are not downloaded', async () => {
    await engine.syncAll();
    write(remoteRoot, 'css/site.css', 'body{color:red}');
    write(remoteRoot, 'added.txt', 'new');
    const r = await engine.syncAll();
    assert.deepEqual(r.downloaded, ['added.txt']);
    assert.ok(!exists(local, 'css/site.css'));
  });

  test('a new local file in an unopened folder never overwrites the server copy', async () => {
    await engine.syncAll();
    write(local, 'css/site.css', 'written by an agent');
    engine.localChanged(path.join(local, 'css/site.css'));
    write(local, 'css/new.css', 'new');
    engine.localChanged(path.join(local, 'css/new.css'));
    await engine.idle();
    assert.equal(read(remoteRoot, 'css/site.css'), 'body{}');
    assert.deepEqual(events.conflicts, [{ rel: 'css/site.css', kind: 'both-changed' }]);
    assert.equal(read(remoteRoot, 'css/new.css'), 'new');
  });

  test('folders deleted on the server disappear locally', async () => {
    await engine.syncAll();
    await engine.fetchDir('css');
    fs.rmSync(path.join(remoteRoot, 'css'), { recursive: true });
    const r = await engine.syncAll();
    assert.deepEqual(r.deletedLocal, ['css/site.css']);
    assert.ok(!exists(local, 'css'));
  });

  test('local edits are uploaded; downloads are not echoed back', async () => {
    await engine.syncAll();
    // simulate the watcher reporting the files we just downloaded
    engine.localChanged(path.join(local, 'index.php'));
    await engine.idle();
    assert.deepEqual(remote.writes, []);

    write(local, 'index.php', '<?php echo 2;');
    engine.localChanged(path.join(local, 'index.php'));
    write(local, 'new/dir/file.txt', 'hello');
    engine.localChanged(path.join(local, 'new'));
    await engine.idle();
    assert.equal(read(remoteRoot, 'index.php'), '<?php echo 2;');
    assert.equal(read(remoteRoot, 'new/dir/file.txt'), 'hello');
    assert.equal((await engine.syncAll()).uploaded.length, 0);
  });

  test('remote changes are downloaded by syncAll', async () => {
    await engine.syncAll();
    await engine.fetchDir('css');
    write(remoteRoot, 'css/site.css', 'body{color:red}');
    write(remoteRoot, 'added.txt', 'new');
    const r = await engine.syncAll();
    assert.deepEqual(r.downloaded.sort(), ['added.txt', 'css/site.css']);
    assert.equal(read(local, 'css/site.css'), 'body{color:red}');
  });

  test('changes made while closed are uploaded on the next syncAll', async () => {
    await engine.syncAll();
    engine.dispose();
    write(local, 'index.php', 'offline edit');
    write(local, 'offline.txt', 'x');
    makeEngine();
    const r = await engine.syncAll();
    assert.deepEqual(r.uploaded.sort(), ['index.php', 'offline.txt']);
    assert.equal(read(remoteRoot, 'index.php'), 'offline edit');
  });

  test('a file changed on both sides is a conflict and is not overwritten', async () => {
    await engine.syncAll();
    write(remoteRoot, 'index.php', 'server version');
    write(local, 'index.php', 'local version!!');
    engine.localChanged(path.join(local, 'index.php'));
    await engine.idle();
    assert.equal(read(remoteRoot, 'index.php'), 'server version');
    assert.equal(read(local, 'index.php'), 'local version!!');
    assert.deepEqual(events.conflicts, [{ rel: 'index.php', kind: 'both-changed' }]);
    assert.deepEqual(engine.conflicts.map(c => c.rel), ['index.php']);

    const r = await engine.syncAll();
    assert.deepEqual(r.conflicts, ['index.php']);
    assert.equal(read(local, 'index.php'), 'local version!!');

    await engine.resolve('index.php', 'local');
    assert.equal(read(remoteRoot, 'index.php'), 'local version!!');
    assert.equal(engine.conflicts.length, 0);
  });

  test("policy 'remote': the server copy wins, the local one is backed up", async () => {
    makeEngine({ conflictPolicy: 'remote', backupDir: path.join(base, 'backups') });
    await engine.syncAll();
    write(remoteRoot, 'index.php', 'server version');
    write(local, 'index.php', 'local version!!');
    engine.localChanged(path.join(local, 'index.php'));
    await engine.idle();
    assert.equal(read(local, 'index.php'), 'server version');
    assert.equal(read(remoteRoot, 'index.php'), 'server version');
    assert.deepEqual(events.conflicts, []);
    const backups = fs.readdirSync(path.join(base, 'backups'));
    assert.equal(backups.length, 1);
    assert.equal(read(path.join(base, 'backups', backups[0]), 'index.php'), 'local version!!');

    // changed on both sides while closed: syncAll downloads the server copy
    write(remoteRoot, 'index.php', 'server again');
    write(local, 'index.php', 'local again!!!');
    const r = await engine.syncAll();
    assert.deepEqual(r.downloaded, ['index.php']);
    assert.deepEqual(r.conflicts, []);
    assert.equal(read(local, 'index.php'), 'server again');

    // local only changes are still uploaded
    write(local, 'index.php', 'only local');
    engine.localChanged(path.join(local, 'index.php'));
    await engine.idle();
    assert.equal(read(remoteRoot, 'index.php'), 'only local');
  });

  test("policy 'remote': deletions follow the server", async () => {
    makeEngine({ conflictPolicy: 'remote', backupDir: path.join(base, 'backups') });
    await engine.syncAll();
    await engine.fetchDir('css');
    // deleted locally, changed on the server: restored
    write(remoteRoot, 'index.php', 'changed on server');
    fs.unlinkSync(path.join(local, 'index.php'));
    // changed locally, deleted on the server: deleted locally
    write(local, 'css/site.css', 'local change');
    fs.unlinkSync(path.join(remoteRoot, 'css/site.css'));
    const r = await engine.syncAll();
    assert.equal(read(local, 'index.php'), 'changed on server');
    assert.ok(!exists(local, 'css/site.css'));
    assert.ok(!exists(remoteRoot, 'css/site.css'));
    assert.deepEqual(r.conflicts, []);
  });

  test("policy 'remote': a file present on both sides with different content takes the server copy", async () => {
    makeEngine({ conflictPolicy: 'remote', backupDir: path.join(base, 'backups') });
    write(local, 'index.php', 'stale local copy');
    const r = await engine.syncAll();
    assert.deepEqual(r.downloaded, ['index.php']);
    assert.equal(read(local, 'index.php'), '<?php echo 1;');
  });

  test("policy 'newest': the copy modified last wins", async () => {
    makeEngine({ conflictPolicy: 'newest', backupDir: path.join(base, 'backups') });
    await engine.syncAll();
    await engine.fetchDir('css');
    const old = new Date(Date.now() - 3600_000);
    // index.php: local newer -> uploaded
    write(remoteRoot, 'index.php', 'server older');
    fs.utimesSync(path.join(remoteRoot, 'index.php'), old, old);
    write(local, 'index.php', 'local newer');
    // css/site.css: server newer -> downloaded
    write(local, 'css/site.css', 'local older');
    fs.utimesSync(path.join(local, 'css/site.css'), old, old);
    write(remoteRoot, 'css/site.css', 'server newer');
    const r = await engine.syncAll();
    assert.deepEqual(r.uploaded, ['index.php']);
    assert.deepEqual(r.downloaded, ['css/site.css']);
    assert.equal(read(remoteRoot, 'index.php'), 'local newer');
    assert.equal(read(local, 'css/site.css'), 'server newer');
    assert.deepEqual(r.conflicts, []);
  });

  test("policy 'newest': a modification beats a deletion", async () => {
    makeEngine({ conflictPolicy: 'newest', backupDir: path.join(base, 'backups') });
    await engine.syncAll();
    await engine.fetchDir('css');
    write(remoteRoot, 'index.php', 'changed on server');
    fs.unlinkSync(path.join(local, 'index.php'));
    write(local, 'css/site.css', 'local change');
    fs.unlinkSync(path.join(remoteRoot, 'css/site.css'));
    await engine.syncAll();
    assert.equal(read(local, 'index.php'), 'changed on server');
    assert.equal(read(remoteRoot, 'css/site.css'), 'local change');
  });

  test('resolve keeping the server copy', async () => {
    await engine.syncAll();
    write(remoteRoot, 'index.php', 'server version');
    write(local, 'index.php', 'local version!!');
    await engine.syncAll();
    await engine.resolve('index.php', 'remote');
    assert.equal(read(local, 'index.php'), 'server version');
    assert.equal((await engine.syncAll()).conflicts.length, 0);
  });

  test('identical files present on both sides are adopted without conflict', async () => {
    write(local, 'index.php', '<?php echo 1;');
    write(local, 'css/site.css', 'different');
    const r = await engine.syncAll();
    assert.deepEqual(r.downloaded, []);
    assert.deepEqual(r.conflicts, ['css/site.css']);
    assert.equal(read(local, 'css/site.css'), 'different');
  });

  test('local deletions are propagated, folders included', async () => {
    await engine.syncAll();
    await engine.fetchDir('css');
    fs.unlinkSync(path.join(local, 'index.php'));
    engine.localChanged(path.join(local, 'index.php'));
    fs.rmSync(path.join(local, 'css'), { recursive: true });
    engine.localChanged(path.join(local, 'css'));
    await engine.idle();
    assert.ok(!exists(remoteRoot, 'index.php'));
    assert.ok(!exists(remoteRoot, 'css'));
    assert.ok(exists(remoteRoot, 'node_modules/x/i.js'), 'excluded files untouched');
  });

  test('a local deletion does not delete a file changed on the server', async () => {
    await engine.syncAll();
    write(remoteRoot, 'index.php', 'changed on server');
    fs.unlinkSync(path.join(local, 'index.php'));
    engine.localChanged(path.join(local, 'index.php'));
    await engine.idle();
    assert.equal(read(remoteRoot, 'index.php'), 'changed on server');
    assert.deepEqual(events.conflicts, [{ rel: 'index.php', kind: 'deleted-locally' }]);
  });

  test('remote file deletions are propagated by syncAll', async () => {
    await engine.syncAll();
    fs.unlinkSync(path.join(remoteRoot, 'index.php'));
    const r = await engine.syncAll();
    assert.deepEqual(r.deletedLocal, ['index.php']);
    assert.ok(!exists(local, 'index.php'));
  });

  test('mass deletions need confirmation; declining keeps the server files', async () => {
    for (let i = 0; i < 6; i++) {
      write(remoteRoot, `many/f${i}.txt`, String(i));
    }
    makeEngine({ confirm: false });
    await engine.syncAll();
    await engine.fetchDir('many');
    fs.rmSync(path.join(local, 'many'), { recursive: true });
    engine.localChanged(path.join(local, 'many'));
    await engine.idle();
    assert.equal(events.confirms.length, 1);
    assert.equal(events.confirms[0].length, 6);
    assert.ok(exists(remoteRoot, 'many/f0.txt'));
    // they come back on the next full sync
    const r = await engine.syncAll();
    assert.equal(r.downloaded.length, 6);
    assert.ok(exists(local, 'many/f5.txt'));
  });

  test('a missing local folder is never treated as "everything deleted"', async () => {
    await engine.syncAll();
    fs.rmSync(local, { recursive: true });
    await assert.rejects(engine.syncAll(), /missing/);
    assert.ok(exists(remoteRoot, 'index.php'));
  });

  test('the manifest survives a restart', async () => {
    await engine.syncAll();
    makeEngine();
    const r = await engine.syncAll();
    assert.equal(r.unchanged, 1);
    assert.equal(r.downloaded.length + r.uploaded.length + r.conflicts.length, 0);
    assert.ok(exists(local, `css/${PLACEHOLDER_NAME}`));
  });

  test('files over the size limit are skipped', async () => {
    write(remoteRoot, 'big.zip', Buffer.alloc(2048));
    makeEngine({ maxFileSize: 1024 });
    const r = await engine.syncAll();
    assert.ok(r.skipped.includes('big.zip'));
    assert.ok(!exists(local, 'big.zip'));
  });
});

// ------------------------------------------------------------ real FTP server

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Same adapter shape as src/mirror.ts, on top of a raw RemoteClient. */
function clientRemote(client, base) {
  const p = rel => path.posix.join(base, '/', rel);
  return {
    async stat(rel) {
      try {
        return await client.stat(p(rel));
      } catch (err) {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      }
    },
    readdir: rel => client.readdir(p(rel)),
    read: rel => client.readFile(p(rel)),
    write: (rel, d) => client.writeFile(p(rel), d),
    async mkdir(rel) {
      try {
        await client.mkdir(p(rel));
      } catch (err) {
        const st = await client.stat(p(rel)).catch(() => undefined);
        if (st?.kind !== 'dir') throw err;
      }
    },
    unlink: rel => client.unlink(p(rel)),
    rmdir: rel => client.rmdir(p(rel)),
  };
}

describe('MirrorEngine over FTP', () => {
  test('round trip is stable (no spurious changes or conflicts)', async () => {
    const { FtpSrv } = require('ftp-srv');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remotefs-mirror-ftp-'));
    const serverRoot = path.join(tmp, 'server');
    const local = path.join(tmp, 'local');
    write(serverRoot, 'site/index.html', '<h1>hi</h1>');
    write(serverRoot, 'site/js/app.js', 'console.log(1)');
    const port = await freePort();
    const quiet = { info() {}, debug() {}, trace() {}, warn() {}, error() {}, child() { return this; } };
    const server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: 40200, pasv_max: 40300, anonymous: false, log: quiet });
    server.on('login', (_d, resolve) => resolve({ root: serverRoot }));
    await server.listen();
    const client = await openClient(
      { scheme: 'ftp', host: '127.0.0.1', port, username: 'u', password: 'p', connectTimeout: 5000 },
      { prompt: async () => undefined }
    );
    const engine = new MirrorEngine({
      localRoot: local,
      remote: clientRemote(client, '/site'),
      manifestPath: path.join(tmp, 'manifest.json'),
      debounce: 10,
    });
    try {
      assert.equal((await engine.syncAll()).downloaded.length, 1);
      assert.ok(exists(local, `js/${PLACEHOLDER_NAME}`));
      await engine.fetchDir('js');
      write(local, 'js/app.js', 'console.log("edited by an agent")');
      write(local, 'js/new.js', 'export {}');
      engine.localChanged(path.join(local, 'js/app.js'));
      engine.localChanged(path.join(local, 'js/new.js'));
      await engine.idle();
      assert.equal(read(serverRoot, 'site/js/app.js'), 'console.log("edited by an agent")');
      assert.equal(read(serverRoot, 'site/js/new.js'), 'export {}');
      const r = await engine.syncAll();
      assert.deepEqual(
        [r.downloaded, r.uploaded, r.conflicts, r.errors],
        [[], [], [], []],
        'second sync must be a no-op'
      );
      assert.equal(r.unchanged, 3);
    } finally {
      engine.dispose();
      client.close();
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
