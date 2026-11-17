## 0.3.1 - 2026-11-17
* Gear button in the title bar of the Remote FS 2 view (and command `Remote FS 2: Open Settings`): opens the settings of the extension.

## 0.3.0 - 2026-11-17
* Local mirror: new setting `remotefs.mirror.conflictResolution` for files changed both locally and on the server (or changed on one side and deleted on the other):
  * `server` (**new default**): the server copy always wins;
  * `newest`: the copy modified last wins, by date (a modification beats a deletion);
  * `ask`: the previous behaviour, the conflict is reported and nothing is overwritten.
* A local copy replaced or deleted by an automatic resolution is first saved in `conflict-backups` in the extension storage (path in the log).

## 0.2.1 - 2026-11-17
* FTP: servers that close the data connection with a reset instead of a normal close (IIS and others) no longer drop the whole connection after every listing or download. That was why remote folders sometimes stayed empty when a workspace was opened ("read ECONNRESET (data socket)" in the log). The reply of the server still decides whether a transfer succeeded.
* Remote workspace folders are reloaded again whenever their connection comes back after failed reads (a reload asked too early is postponed instead of skipped).

## 0.2.0 - 2026-11-17
* Remote workspace folders load by themselves when a workspace is opened: the connections are made at startup and the folders are re-read as soon as a connection is restored after failed reads (no more manual Refresh).
* FTP: a file inside a missing folder (e.g. `.vscode/settings.json`, probed by VS Code on startup) is no longer looked up by listing that folder, which made some servers drop the connection over and over. The reason of an unexpected disconnection is now written to the log.
* New status bar item with the activity of the remote connections: connecting / connected / busy (operations in progress) / error; the tooltip shows data downloaded and uploaded, operations, last operation and last error; click for Refresh, Show Log, Connect/Disconnect.

## 0.1.0 - 2026-11-17
* First release of the **Remote FS 2** fork (publisher `michediana`), based on liximomo/vscode-remote-fs 0.0.16.
* Requires VS Code 1.90+. Rewritten on current APIs (`@types/vscode`, LogOutputChannel, SecretStorage, workspace trust).
* New **Remote FS 2** Activity Bar view: manage connections from a form, test them, connection status, inline buttons to add a connection to the workspace or open its local mirror.
* Passwords/passphrases stored in the OS keychain; plain-text passwords are moved there when the connection is edited.
* SSH host key verification (trust on first use).
* ssh2 1.x: modern algorithms (rsa-sha2-256/512, ed25519, curve25519), works with OpenSSH 8.8+.
* FTP client replaced (`jsftp` → `basic-ftp`), new `ftps` scheme (explicit/implicit TLS).
* **Local mirror**: a remote folder mirrored to a local folder, downloaded on demand (folders are downloaded when expanded in the Explorer or requested by an agent through a trigger file) and kept in sync both ways (watcher-based upload, conflict detection with diff, confirmation for mass deletions), so AI agents like Claude Code and command-line tools can work on remote projects. Settings under `remotefs.mirror.*`.
* Workspace folders are labelled with the connection name by default (`remotefs.rootLabel` = `${label}`).
* Relative `rootPath` (`~/www`), `~`/`$ENV` expansion in key and agent paths.
* Automatic reconnection when a connection drops; connections are closed when their settings change.
* Fixes: connection errors crashing with `TypeError`, rename checking the wrong path, cancelled password prompt still connecting, wrong error codes (FileNotFound/FileExists), stale connections for names with upper-case letters, duplicate error notifications, default FTP port shown as 22.

## 0.0.15 - 2019-04-27
* Fix [#56](https://github.com/liximomo/vscode-remote-fs/issues/56).
  
## 0.0.13 - 2019-01-08
* Custom label of the root folder by setting `remotefs.rootLabel`.

## 0.0.11 - 2018-08-14
* Open remote from terminal [CLI](https://github.com/liximomo/vscode-remote-fs#cli).
* Better suuport for symbolic link.

