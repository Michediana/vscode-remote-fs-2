# Remote FS for VS Code

Work with files on SFTP, FTP and FTPS servers as if they were local: remote folders open in the Explorer, files open in normal editors, and saving writes straight to the server.

> Fork of [liximomo/vscode-remote-fs](https://github.com/liximomo/vscode-remote-fs), updated for current VS Code versions.

## Features

* **Remote FS view** in the Activity Bar: add, edit, duplicate, delete and test connections without touching JSON; browse remote files directly from the tree.
* SFTP (password, private key, SSH agent, keyboard-interactive / 2FA), FTP and FTPS (explicit or implicit TLS).
* Passwords and key passphrases are stored in the **OS keychain** (VS Code SecretStorage), never in `settings.json`.
* SSH **host key verification** (trust on first use, warning when a key changes).
* Several remotes at once in a multi-root workspace; open a remote in a new window.
* Automatic reconnection when a connection drops.

## Getting started

1. Open the **Remote FS** view in the Activity Bar and click **+** (or run `Remote FS: Add Connection`).
2. Fill in the form, press **Test Connection**, then **Save**.
3. Right-click the connection → **Add to Workspace** or **Open in New Window**, or just expand it to browse files.

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

`remotefs.rootLabel` sets the workspace folder label. Default `${label}` (the connection label, or its name); variables: `${label}`, `${name}`, `${folderName}`, `${path}`.

## Commands

All available from the Command Palette under **Remote FS**: Add / Edit / Delete Connection, Add Folder to Workspace, Open in New Window, Test Connection, Disconnect, Disconnect All, Forget Saved Password, Refresh, Edit Connections in settings.json, Show Log.

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
