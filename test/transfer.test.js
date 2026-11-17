// Tests of the connections export/import format (out/transfer).
// Run with: npm test
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildExport, parseExport, splitSecrets, WrongPassphraseError } = require('../out/transfer');

const entries = [
  {
    name: 'prod',
    config: { scheme: 'sftp', host: 'example.com', username: 'deploy', rootPath: '/var/www', privateKeyPath: '~/.ssh/id_ed25519' },
    secrets: { password: undefined, passphrase: 'key-secret' },
  },
  {
    name: 'legacy',
    // plain-text password kept in settings by old versions
    config: { scheme: 'ftp', host: 'ftp.example.com', username: 'me', password: 'in-settings' },
    secrets: {},
  },
  {
    name: 'nopass',
    config: { scheme: 'ftps', host: 'files.example.com', passphrase: true },
    secrets: {},
  },
];

const roundTrip = async (mode, passphrase) => parseExport(JSON.stringify(await buildExport(entries, mode, passphrase)));

describe('splitSecrets', () => {
  test('removes password and passphrase strings, keeps passphrase: true', () => {
    assert.deepEqual(splitSecrets({ scheme: 'sftp', host: 'h', password: 'p', passphrase: 'k' }), {
      config: { scheme: 'sftp', host: 'h' },
      secrets: { password: 'p', passphrase: 'k' },
    });
    assert.deepEqual(splitSecrets({ scheme: 'sftp', host: 'h', passphrase: true }).config, {
      scheme: 'sftp',
      host: 'h',
      passphrase: true,
    });
  });
});

describe('export', () => {
  test('never writes secrets inside the connection configs', async () => {
    for (const mode of ['none', 'plain', 'encrypted']) {
      const file = await buildExport(entries, mode, 'correct horse');
      const configs = JSON.stringify(file.connections);
      assert.ok(!configs.includes('in-settings'), mode);
      assert.ok(!configs.includes('key-secret'), mode);
    }
  });

  test('mode none drops every secret', async () => {
    const text = JSON.stringify(await buildExport(entries, 'none'));
    assert.ok(!text.includes('in-settings'));
    assert.ok(!text.includes('key-secret'));
    const parsed = parseExport(text);
    assert.equal(parsed.mode, 'none');
    assert.ok(parsed.entries.every(e => !e.secrets.password && !e.secrets.passphrase));
  });

  test('encrypted file does not contain the secrets in clear', async () => {
    const text = JSON.stringify(await buildExport(entries, 'encrypted', 'correct horse'));
    assert.ok(!text.includes('in-settings'));
    assert.ok(!text.includes('key-secret'));
  });

  test('encrypted mode requires a passphrase', async () => {
    await assert.rejects(buildExport(entries, 'encrypted'));
  });
});

describe('import', () => {
  test('plain round trip restores configs and secrets', async () => {
    const parsed = await roundTrip('plain');
    assert.equal(parsed.mode, 'plain');
    assert.deepEqual(parsed.invalid, []);
    const byName = Object.fromEntries(parsed.entries.map(e => [e.name, e]));
    assert.deepEqual(byName.prod.config, entries[0].config);
    assert.deepEqual(byName.prod.secrets, { passphrase: 'key-secret' });
    assert.deepEqual(byName.legacy.secrets, { password: 'in-settings' });
    assert.equal(byName.legacy.config.password, undefined);
    assert.equal(byName.nopass.config.passphrase, true);
  });

  test('encrypted round trip with the right passphrase', async () => {
    const parsed = await roundTrip('encrypted', 'correct horse');
    assert.equal(parsed.mode, 'encrypted');
    assert.deepEqual(await parsed.decryptSecrets('correct horse'), {
      prod: { passphrase: 'key-secret' },
      legacy: { password: 'in-settings' },
    });
  });

  test('wrong passphrase is reported as such', async () => {
    const parsed = await roundTrip('encrypted', 'correct horse');
    await assert.rejects(parsed.decryptSecrets('wrong'), WrongPassphraseError);
  });

  test('tampered ciphertext is rejected', async () => {
    const file = await buildExport(entries, 'encrypted', 'correct horse');
    const data = Buffer.from(file.encryptedSecrets.data, 'base64');
    data[0] ^= 1;
    file.encryptedSecrets.data = data.toString('base64');
    await assert.rejects(parseExport(JSON.stringify(file)).decryptSecrets('correct horse'), WrongPassphraseError);
  });

  test('excessive scrypt cost is refused', async () => {
    const file = await buildExport(entries, 'encrypted', 'correct horse');
    file.encryptedSecrets.N = 1 << 30;
    await assert.rejects(parseExport(JSON.stringify(file)).decryptSecrets('correct horse'), /Unsupported/);
  });

  test('rejects files that are not an export', () => {
    assert.throws(() => parseExport('not json'), /not valid JSON/);
    assert.throws(() => parseExport('{"remotefs.remote": {}}'), /not a Remote FS 2/);
    assert.throws(
      () => parseExport(JSON.stringify({ format: 'remotefs-connections', version: 99, connections: {} })),
      /newer version/
    );
  });

  test('skips invalid entries and unknown keys', () => {
    const parsed = parseExport(
      JSON.stringify({
        format: 'remotefs-connections',
        version: 1,
        secrets: 'none',
        connections: {
          ok: { scheme: 'SFTP', host: 'h', evil: 'x' },
          'bad name': { scheme: 'sftp', host: 'h' },
          nohost: { scheme: 'sftp' },
          badscheme: { scheme: 'http', host: 'h' },
        },
      })
    );
    assert.deepEqual(parsed.entries.map(e => e.name), ['ok']);
    assert.deepEqual(parsed.entries[0].config, { scheme: 'sftp', host: 'h' });
    assert.deepEqual(parsed.invalid.sort(), ['bad name', 'badscheme', 'nohost']);
  });
});
