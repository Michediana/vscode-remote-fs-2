// Minimal SFTP server backed by a local directory, for tests only.
'use strict';
const fs = require('fs');
const path = require('path');
const { Server, utils } = require('ssh2');

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

function statusFor(err) {
  if (!err) return STATUS_CODE.OK;
  if (err.code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
  if (err.code === 'EACCES' || err.code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function attrsOf(st) {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function flagsToFs(flags) {
  let f = '';
  if (flags & OPEN_MODE.READ) f = 'r';
  if (flags & OPEN_MODE.WRITE) f = flags & OPEN_MODE.TRUNC ? 'w' : flags & OPEN_MODE.APPEND ? 'a' : 'r+';
  if ((flags & OPEN_MODE.READ) && (flags & OPEN_MODE.WRITE)) f = flags & OPEN_MODE.TRUNC ? 'w+' : 'r+';
  if (flags & OPEN_MODE.EXCL) f += 'x';
  if ((flags & OPEN_MODE.CREAT) && f === 'r+') f = 'a+';
  return f;
}

/**
 * Starts a server on 127.0.0.1. `root` maps to "/" on the remote side.
 * Resolves { port, close, hostKeyFingerprint }.
 */
function startSftpServer({ root, username = 'user', password = 'secret' }) {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const real = p => path.join(root, path.posix.normalize('/' + p));

  const server = new Server({ hostKeys: [hostKey] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
        return ctx.accept();
      }
      if (ctx.method === 'keyboard-interactive' && ctx.username === username) {
        return ctx.prompt([{ prompt: 'Verification code: ', echo: true }], answers =>
          answers[0] === '123456' ? ctx.accept() : ctx.reject()
        );
      }
      ctx.reject(['password', 'keyboard-interactive']);
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('sftp', acceptSftp => {
          const sftp = acceptSftp();
          const handles = new Map();
          let next = 0;
          const newHandle = value => {
            const id = next++;
            const buf = Buffer.alloc(4);
            buf.writeUInt32BE(id);
            handles.set(id, value);
            return buf;
          };
          const getHandle = buf => (buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : undefined);

          sftp.on('OPEN', (reqid, filename, flags, attrs) => {
            fs.open(real(filename), flagsToFs(flags), attrs && attrs.mode ? attrs.mode : 0o644, (err, fd) => {
              if (err) return sftp.status(reqid, statusFor(err));
              sftp.handle(reqid, newHandle({ fd }));
            });
          });
          sftp.on('READ', (reqid, handle, offset, length) => {
            const h = getHandle(handle);
            if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
            const buf = Buffer.alloc(length);
            fs.read(h.fd, buf, 0, length, offset, (err, n) => {
              if (err) return sftp.status(reqid, statusFor(err));
              if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
              sftp.data(reqid, buf.subarray(0, n));
            });
          });
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const h = getHandle(handle);
            if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
            fs.write(h.fd, data, 0, data.length, offset, err => sftp.status(reqid, statusFor(err)));
          });
          sftp.on('FSTAT', (reqid, handle) => {
            const h = getHandle(handle);
            if (!h || h.dir) return sftp.status(reqid, STATUS_CODE.FAILURE);
            fs.fstat(h.fd, (err, st) => (err ? sftp.status(reqid, statusFor(err)) : sftp.attrs(reqid, attrsOf(st))));
          });
          sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on('CLOSE', (reqid, handle) => {
            const h = getHandle(handle);
            if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
            handles.delete(handle.readUInt32BE(0));
            if (h.dir) return sftp.status(reqid, STATUS_CODE.OK);
            fs.close(h.fd, err => sftp.status(reqid, statusFor(err)));
          });
          sftp.on('OPENDIR', (reqid, p) => {
            fs.readdir(real(p), (err, names) => {
              if (err) return sftp.status(reqid, statusFor(err));
              sftp.handle(reqid, newHandle({ dir: real(p), names, sent: false }));
            });
          });
          sftp.on('READDIR', (reqid, handle) => {
            const h = getHandle(handle);
            if (!h || !h.dir) return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (h.sent) return sftp.status(reqid, STATUS_CODE.EOF);
            h.sent = true;
            sftp.name(
              reqid,
              h.names.map(name => {
                const st = fs.lstatSync(path.join(h.dir, name));
                return { filename: name, longname: name, attrs: attrsOf(st) };
              })
            );
          });
          const statHandler = fn => (reqid, p) =>
            fn(real(p), (err, st) => (err ? sftp.status(reqid, statusFor(err)) : sftp.attrs(reqid, attrsOf(st))));
          sftp.on('STAT', statHandler(fs.stat));
          sftp.on('LSTAT', statHandler(fs.lstat));
          sftp.on('MKDIR', (reqid, p) => fs.mkdir(real(p), err => sftp.status(reqid, statusFor(err))));
          sftp.on('RMDIR', (reqid, p) => fs.rmdir(real(p), err => sftp.status(reqid, statusFor(err))));
          sftp.on('REMOVE', (reqid, p) => fs.unlink(real(p), err => sftp.status(reqid, statusFor(err))));
          sftp.on('RENAME', (reqid, from, to) => {
            // SFTPv3 rename must fail when the target exists
            if (fs.existsSync(real(to))) return sftp.status(reqid, STATUS_CODE.FAILURE);
            fs.rename(real(from), real(to), err => sftp.status(reqid, statusFor(err)));
          });
          sftp.on('REALPATH', (reqid, p) => {
            const abs = path.posix.normalize(p.startsWith('/') ? p : '/home/' + p);
            sftp.name(reqid, [{ filename: abs === '/home/.' ? '/home' : abs.replace(/\/\.$/, ''), longname: '', attrs: {} }]);
          });
          sftp.on('READLINK', (reqid, p) =>
            fs.readlink(real(p), (err, target) =>
              err ? sftp.status(reqid, statusFor(err)) : sftp.name(reqid, [{ filename: target, longname: '', attrs: {} }])
            )
          );
        });
      });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

module.exports = { startSftpServer };
