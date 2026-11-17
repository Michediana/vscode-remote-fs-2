# Remote FS 2 for VS Code

Work with files on SFTP, FTP and FTPS servers as if they were local: remote folders open in the Explorer, files open in normal editors, and saving writes straight to the server.

> **This is a maintained fork of [liximomo/vscode-remote-fs](https://github.com/liximomo/vscode-remote-fs)**, which has not been updated since 2019. All credit for the original idea and code goes to its author.

## What's new in this fork

The extension has been largely rewritten on current VS Code APIs. Compared to the original (0.0.16):

**Modernised**
* Requires VS Code 1.90+; rebuilt on the current extension API (SecretStorage, LogOutputChannel, workspace trust, virtual workspaces).
* `ssh2` upgraded to 1.x: modern algorithms (rsa-sha2-256/512, ed25519, curve25519), so it connects to OpenSSH 8.8+ servers that the original rejects.
* FTP client replaced (`jsftp` → `basic-ftp`), with a new `ftps` scheme (explicit and implicit TLS).

**New features**
* **Remote FS 2 view** in the Activity Bar: create, edit, test and delete connections from a form instead of editing JSON, with live connection status.
* **Passwords in the OS keychain** instead of `settings.json`; existing plain-text passwords are moved there when you edit the connection.
* **SSH host key verification** (trust on first use, warning when a key changes).
* **Local mirror** for AI agents, terminals and git: a remote folder mirrored to a local folder, downloaded on demand and kept in sync both ways, with conflict detection (see [below](#local-mirror-ai-agents-terminal-git)).
* **Activity in the status bar**: connection state, operations in progress, data transferred, last operation and last error.
* Remote workspace folders load by themselves when a saved workspace is opened (no manual Refresh needed).
* Automatic reconnection, relative `rootPath` (`~/www`), `~` / `$ENV` expansion in key and agent paths, keyboard-interactive / 2FA prompts.

**Fixes**
* Connection errors crashing with `TypeError`, rename checking the wrong path, a cancelled password prompt still connecting, wrong FileNotFound/FileExists errors, stale connections for names with upper-case letters, duplicate error notifications, default FTP port shown as 22.

See the [CHANGELOG](CHANGELOG.md) for details.

### Migrating from the original extension

Settings are compatible: existing `remotefs.remote` connections work as they are. **Uninstall the original Remote FS first** — both extensions register the same `sftp://` / `ftp://` file systems and commands and cannot run side by side. Remote FS 2 shows a warning at startup if the original is still enabled.

## Features

* **Remote FS 2 view** in the Activity Bar: add, edit, duplicate, delete and test connections without touching JSON; inline buttons add a connection to the workspace or open its local mirror.
* SFTP (password, private key, SSH agent, keyboard-interactive / 2FA), FTP and FTPS (explicit or implicit TLS).
* Passwords and key passphrases are stored in the **OS keychain** (VS Code SecretStorage), never in `settings.json`.
* SSH **host key verification** (trust on first use, warning when a key changes).
* Several remotes at once in a multi-root workspace; open a remote in a new window.
* Automatic reconnection when a connection drops; remote workspace folders are connected and loaded as soon as a workspace opens.
* **Status bar activity** of the remote connections (see [below](#status-bar)).
* **Local mirror** of a remote folder, kept in sync both ways, so that **AI agents (Claude Code, Copilot, Cursor, Codex…)**, terminals and command-line tools can work on the files.

## Getting started

1. Open the **Remote FS 2** view in the Activity Bar and click **+** (or run `Remote FS 2: Add Connection`).
2. Fill in the form, press **Test Connection**, then **Save**.
3. Right-click the connection → **Add to Workspace**, **Open in New Window** or **Open Local Mirror** (also available as inline buttons).

Status icons in the view: green = connected, spinning = connecting, red = last attempt failed (hover for the error).

## Status bar

When the workspace contains a remote folder, or a connection is open, a status bar item shows what the connections are doing:

| Item | Meaning |
|:--|:--|
| spinning circle + name | connecting |
| spinning arrows + `name · 3` | 3 operations in progress (listing, reading, writing, mirror sync…) |
| cloud + name | connected, idle |
| crossed cloud + name, red background | the connection failed |
| cloud + `2/3` | several connections: connected / total |

Hover it for the details of each connection: state, data downloaded and uploaded, number of operations, last operation with its time and last error. Click it for **Refresh Remote Folders**, **Show Log** and **Connect / Disconnect** (also `Remote FS 2: Show Connection Activity`). The local mirror has its own item (sync state and conflicts).

## Configuration

Connections live in the `remotefs.remote` setting (user settings by default, workspace settings are honoured in trusted workspaces). The key is the connection name and is used as the URI authority (case-insensitive).

```jsonc
"remotefs.remote": {
  "dev": {
    "scheme": "sftp",
    "host": "dev.example.com",
    "username": "me",
    "privateKeyPath": "~/.ssh/id_ed25519",
    "rootPath": "/var/www"
  },
  "site": {
    "scheme": "ftps",
    "host": "ftp.example.com",
    "username": "me",
    "rootPath": "~/htdocs"
  }
}
```

| Option | Protocols | Description |
| --- | --- | --- |
| `scheme` | all | `sftp`, `ftp` or `ftps` |
| `host`, `port` | all | Port defaults to 22 (sftp) / 21 (ftp, ftps) |
| `username` | all | |
| `password` | all | Plain-text password — discouraged, use the editor to store it in the keychain. If no password is available you are prompted. |
| `rootPath` | all | Root of the remote file system. Absolute, or relative to the login directory (`~/www`). Default `/` |
| `connectTimeout` | all | Milliseconds, default 10000 (time spent answering prompts is not counted) |
| `label` | all | Display name in the view |
| `privateKeyPath` | sftp | `~` and `$ENV` are expanded |
| `passphrase` | sftp | Passphrase string, or `true` to be prompted. Encrypted keys without passphrase also trigger a prompt. |
| `agent` | sftp | ssh-agent socket, e.g. `$SSH_AUTH_SOCK`, or `pageant` on Windows |
| `interactiveAuth` | sftp | Enable keyboard-interactive auth (OTP / 2FA prompts) |
| `algorithms` | sftp | Passed as-is to [ssh2](https://github.com/mscdex/ssh2#client-methods) |
| `secure` | ftp | `true` = explicit FTPS, `"implicit"` = implicit FTPS |
| `rejectUnauthorized` | ftps | `false` to accept self-signed certificates |

`remotefs.rootLabel` sets the workspace folder label. Default `${label}` (the connection label, or its name, followed by ` (remote)` so it is not confused with a local mirror, which is labelled ` (Local Mirror)`); variables: `${label}`, `${name}`, `${folderName}`, `${path}`.

### Sharing connections

**Export Connections…** (view `…` menu, or right-click a connection) writes the selected connections to a JSON file; a colleague loads it with **Import Connections…**. Passwords and key passphrases can be:

* **encrypted** (recommended): AES-256-GCM with a key derived (scrypt) from a passphrase you choose — send the passphrase over a different channel than the file;
* **left out**: the recipient enters the credentials on the first connection;
* **in plain text**: only over a secure channel, delete the file afterwards.

On import you choose which connections to load, what to do with names that already exist (overwrite, keep both, skip) and whether to save them in user or workspace settings. Imported passwords go to the OS keychain, never to `settings.json`. A `privateKeyPath` that does not exist on the importing computer is reported, so it can be changed.

## Local mirror (AI agents, terminal, git)

`sftp://` / `ftp://` workspace folders exist only inside VS Code: AI agents and anything else that reads the disk or runs shell commands cannot see them. A **local mirror** solves this: the remote folder is mirrored to a normal local folder, **downloaded on demand**, and every change made there — by you, by an AI agent, by a script — is uploaded to the server automatically.

1. Right-click a connection or a folder in the **Remote FS 2** view (or an `ftp://`/`sftp://` folder in the Explorer) → **Open Local Mirror (for AI agents)**.
2. Choose where to keep it (default `~/RemoteFS/<connection>/<path>`). Only the top folder is downloaded: it takes seconds even for big projects (PrestaShop, WordPress, Magento…).
3. Open it **in a new window** so it becomes the project root (the working directory of Claude Code and other agents).

On-demand download:

* A folder never opened is an empty local folder containing only `_remotefs_not_downloaded.txt`. **Expanding it in the Explorer downloads it** (its files; its sub-folders stay on demand) and the placeholder disappears.
* Explorer context menu → **Download Folder from Server**: one folder, or a folder with all its sub-folders.
* **AI agents / terminal**: the placeholder explains it — create `.remotefs-download` in a folder to download it, or `.remotefs-download-all` to download it with all sub-folders (`touch app/.remotefs-download`). The trigger file is removed when done.
* Files created by an agent inside a folder not downloaded yet are uploaded normally, but never blindly over an existing server file: if one exists with different content it is handled as a conflict (see below).

How it stays in sync:

* **Local → server**: changes, new files and deletions in the mirror are uploaded within a fraction of a second (file watcher), including changes made outside VS Code.
* **Server → local**: the folders already downloaded are re-checked when the mirror is opened, when you click the status bar item / run **Sync Local Mirror Now**, and every `remotefs.mirror.autoSyncInterval` seconds if set. Folders never opened are never listed.
* **Conflicts** — a file changed on both sides, or changed on one and deleted on the other — are settled by `remotefs.mirror.conflictResolution`:
  * `server` (default): **the server always wins**. The local copy is replaced by the server one, or deleted if the file was deleted on the server.
  * `newest`: **the copy modified last wins**, by date; a modification beats a deletion; when the server does not report a date the server wins. FTP servers often report dates rounded to the minute or in their own time zone: prefer `server` or `ask` if that is your case.
  * `ask`: nothing is overwritten. You get a notification with **Compare** (diff server ↔ local), **Upload Local** and **Download Server Copy**; the status bar shows pending conflicts.

  A local copy replaced or deleted automatically is first saved in the extension storage (`conflict-backups/<mirror>/<date>/…`; the log shows the exact path). Changes made on one side only are always synced, whatever the setting.
* **Safety**: deleting 10 or more files at once asks for confirmation before deleting them on the server; a missing local folder is never interpreted as "delete everything"; deleting a folder never downloaded does not delete anything on the server (it comes back as a placeholder).
* The sync state is kept in VS Code's storage, not in the folder. Placeholder and trigger files are never uploaded. **Stop Syncing Local Mirror** unlinks the folder and keeps the files.

| Setting | Default | Description |
| --- | --- | --- |
| `remotefs.mirror.baseFolder` | `~/RemoteFS` | Where new mirrors are created |
| `remotefs.mirror.exclude` | `.git`, `node_modules`, `.DS_Store`, `Thumbs.db` | Never synced. Names match at any depth (`*.log`), paths with `/` are relative to the mirror root (`wp-content/uploads`) |
| `remotefs.mirror.maxFileSizeMB` | `50` | Larger files are skipped (`0` = no limit) |
| `remotefs.mirror.conflictResolution` | `server` | Who wins when a file changed on both sides: `server`, `newest` (by date) or `ask` |
| `remotefs.mirror.autoSyncInterval` | `0` | Seconds between automatic re-checks of the downloaded folders on the server (`0` = off, minimum 30) |

## Commands

All available from the Command Palette under **Remote FS 2**: Add / Edit / Delete Connection, Export / Import Connections, Add Folder to Workspace, Open in New Window, Open Local Mirror, Download Folder from Server, Sync Local Mirror Now, Resolve Local Mirror Conflicts, Stop Syncing Local Mirror, Show Connection Activity, Open Settings, Test Connection, Disconnect, Disconnect All, Forget Saved Password, Refresh, Edit Connections in settings.json, Show Log.

Remote servers cannot notify changes: use **Refresh** to reload folders changed by others.

## CLI

```
code --folder-uri <scheme>://<connection-name>[/path]
code --folder-uri sftp://dev/          # opens rootPath of "dev"
code --folder-uri sftp://dev/src       # opens rootPath/src
```

Add `?absolute` to the URI to ignore `rootPath`.

## Development

```
npm install
npm test                  # protocol tests against in-process SFTP and FTP servers
npm run test:integration  # end-to-end tests inside a downloaded VS Code (VSCODE_VERSION=1.90.0 to test the minimum)
npm run package           # build the .vsix
```

Press F5 in VS Code to launch an Extension Development Host.
