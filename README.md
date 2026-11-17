# Remote FS for VS Code

Work with files on SFTP, FTP and FTPS servers as if they were local: remote folders open in the Explorer, files open in normal editors, and saving writes straight to the server.

> Fork of [liximomo/vscode-remote-fs](https://github.com/liximomo/vscode-remote-fs), updated for current VS Code versions.

## Features

* **Remote FS view** in the Activity Bar: add, edit, duplicate, delete and test connections without touching JSON; inline buttons add a connection to the workspace or open its local mirror.
* SFTP (password, private key, SSH agent, keyboard-interactive / 2FA), FTP and FTPS (explicit or implicit TLS).
* Passwords and key passphrases are stored in the **OS keychain** (VS Code SecretStorage), never in `settings.json`.
* SSH **host key verification** (trust on first use, warning when a key changes).
* Several remotes at once in a multi-root workspace; open a remote in a new window.
* Automatic reconnection when a connection drops.
* **Local mirror** of a remote folder, kept in sync both ways, so that **AI agents (Claude Code, Copilot, Cursor, Codex…)**, terminals and command-line tools can work on the files.

## Getting started

1. Open the **Remote FS** view in the Activity Bar and click **+** (or run `Remote FS: Add Connection`).
2. Fill in the form, press **Test Connection**, then **Save**.
3. Right-click the connection → **Add to Workspace**, **Open in New Window** or **Open Local Mirror** (also available as inline buttons).

Status icons in the view: green = connected, spinning = connecting, red = last attempt failed (hover for the error).

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

## Local mirror (AI agents, terminal, git)

`sftp://` / `ftp://` workspace folders exist only inside VS Code: AI agents and anything else that reads the disk or runs shell commands cannot see them. A **local mirror** solves this: the remote folder is mirrored to a normal local folder, **downloaded on demand**, and every change made there — by you, by an AI agent, by a script — is uploaded to the server automatically.

1. Right-click a connection or a folder in the **Remote FS** view (or an `ftp://`/`sftp://` folder in the Explorer) → **Open Local Mirror (for AI agents)**.
2. Choose where to keep it (default `~/RemoteFS/<connection>/<path>`). Only the top folder is downloaded: it takes seconds even for big projects (PrestaShop, WordPress, Magento…).
3. Open it **in a new window** so it becomes the project root (the working directory of Claude Code and other agents).

On-demand download:

* A folder never opened is an empty local folder containing only `_remotefs_not_downloaded.txt`. **Expanding it in the Explorer downloads it** (its files; its sub-folders stay on demand) and the placeholder disappears.
* Explorer context menu → **Download Folder from Server**: one folder, or a folder with all its sub-folders.
* **AI agents / terminal**: the placeholder explains it — create `.remotefs-download` in a folder to download it, or `.remotefs-download-all` to download it with all sub-folders (`touch app/.remotefs-download`). The trigger file is removed when done.
* Files created by an agent inside a folder not downloaded yet are uploaded normally, but never over an existing server file: if one exists with different content it is reported as a conflict.

How it stays in sync:

* **Local → server**: changes, new files and deletions in the mirror are uploaded within a fraction of a second (file watcher), including changes made outside VS Code.
* **Server → local**: the folders already downloaded are re-checked when the mirror is opened, when you click the status bar item / run **Sync Local Mirror Now**, and every `remotefs.mirror.autoSyncInterval` seconds if set. Folders never opened are never listed.
* **Conflicts**: a file is never overwritten when it changed on both sides (or was deleted on one and changed on the other). You get a notification with **Compare** (diff server ↔ local), **Upload Local** and **Download Server Copy**; the status bar shows pending conflicts.
* **Safety**: deleting 10 or more files at once asks for confirmation before deleting them on the server; a missing local folder is never interpreted as "delete everything"; deleting a folder never downloaded does not delete anything on the server (it comes back as a placeholder).
* The sync state is kept in VS Code's storage, not in the folder. Placeholder and trigger files are never uploaded. **Stop Syncing Local Mirror** unlinks the folder and keeps the files.

| Setting | Default | Description |
| --- | --- | --- |
| `remotefs.mirror.baseFolder` | `~/RemoteFS` | Where new mirrors are created |
| `remotefs.mirror.exclude` | `.git`, `node_modules`, `.DS_Store`, `Thumbs.db` | Never synced. Names match at any depth (`*.log`), paths with `/` are relative to the mirror root (`wp-content/uploads`) |
| `remotefs.mirror.maxFileSizeMB` | `50` | Larger files are skipped (`0` = no limit) |
| `remotefs.mirror.autoSyncInterval` | `0` | Seconds between automatic re-checks of the downloaded folders on the server (`0` = off, minimum 30) |

## Commands

All available from the Command Palette under **Remote FS**: Add / Edit / Delete Connection, Add Folder to Workspace, Open in New Window, Open Local Mirror, Download Folder from Server, Sync Local Mirror Now, Resolve Local Mirror Conflicts, Stop Syncing Local Mirror, Test Connection, Disconnect, Disconnect All, Forget Saved Password, Refresh, Edit Connections in settings.json, Show Log.

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
