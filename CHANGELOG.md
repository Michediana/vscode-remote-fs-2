## 0.1.0 - 2026-11-17
* Requires VS Code 1.90+. Rewritten on current APIs (`@types/vscode`, LogOutputChannel, SecretStorage, workspace trust).
* New **Remote FS** Activity Bar view: manage connections from a form, test them, browse remote files, connection status.
* Passwords/passphrases stored in the OS keychain; plain-text passwords are moved there when the connection is edited.
* SSH host key verification (trust on first use).
* ssh2 1.x: modern algorithms (rsa-sha2-256/512, ed25519, curve25519), works with OpenSSH 8.8+.
* FTP client replaced (`jsftp` → `basic-ftp`), new `ftps` scheme (explicit/implicit TLS).
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

