import { randomBytes } from 'crypto';
import * as os from 'os';
import * as vscode from 'vscode';
import {
  Connection,
  ConnectionConfig,
  ConnectionStore,
  NAME_PATTERN,
  connectionId,
  defaultPort,
} from '../config';
import { ConnectionManager, connectWithPrompts, createInteraction } from '../connectionManager';
import logger from '../logger';
import { RemoteError, Scheme, errorMessage } from '../remote';

type AuthMethod = 'password' | 'key' | 'agent';

/** Data exchanged with the webview form. */
interface FormData {
  name: string;
  label: string;
  scheme: Scheme;
  host: string;
  port: string;
  username: string;
  rootPath: string;
  connectTimeout: string;
  auth: AuthMethod;
  password: string;
  /** Store the typed password in the keychain (otherwise ask at every connection). */
  savePassword: boolean;
  forgetPassword: boolean;
  privateKeyPath: string;
  passphrase: string;
  forgetPassphrase: boolean;
  agent: string;
  interactiveAuth: boolean;
  implicitTls: boolean;
  rejectUnauthorized: boolean;
}

interface FormMeta {
  isNew: boolean;
  hasSavedPassword: boolean;
  hasSavedPassphrase: boolean;
  plaintextPassword: boolean;
  workspaceScoped: boolean;
  hasAlgorithms: boolean;
}

type InboundMessage =
  | { type: 'ready' }
  | { type: 'save'; data: FormData }
  | { type: 'test'; data: FormData }
  | { type: 'browseKey' }
  | { type: 'openSettings' }
  | { type: 'cancel' };

function toForm(conn: Connection | undefined, duplicate: boolean): FormData {
  const c: Partial<ConnectionConfig> = conn?.config ?? { scheme: 'sftp' };
  const auth: AuthMethod = c.privateKeyPath ? 'key' : c.agent ? 'agent' : 'password';
  return {
    name: conn ? (duplicate ? `${conn.name}-copy` : conn.name) : '',
    label: c.label ?? '',
    scheme: c.scheme ?? 'sftp',
    host: c.host ?? '',
    port: c.port ? String(c.port) : '',
    username: c.username ?? '',
    rootPath: c.rootPath ?? '',
    connectTimeout: c.connectTimeout ? String(c.connectTimeout) : '',
    auth,
    password: c.password ?? '',
    savePassword: true,
    forgetPassword: false,
    privateKeyPath: c.privateKeyPath ?? '',
    passphrase: typeof c.passphrase === 'string' ? c.passphrase : '',
    forgetPassphrase: false,
    agent: c.agent ?? (auth === 'agent' ? '$SSH_AUTH_SOCK' : ''),
    interactiveAuth: !!c.interactiveAuth,
    implicitTls: c.secure === 'implicit',
    rejectUnauthorized: c.rejectUnauthorized !== false,
  };
}

function validate(d: FormData, store: ConnectionStore, original?: Connection): string | undefined {
  if (!d.name.trim()) {
    return 'Name is required.';
  }
  if (!NAME_PATTERN.test(d.name.trim())) {
    return 'Name may contain only letters, digits, ".", "_" and "-" (it is used in the URI).';
  }
  const clash = store.get(d.name.trim());
  if (clash && clash.id !== original?.id) {
    return `A connection named "${clash.name}" already exists.`;
  }
  if (!d.host.trim()) {
    return 'Host is required.';
  }
  if (d.port && !(Number(d.port) > 0 && Number(d.port) < 65536)) {
    return 'Port must be a number between 1 and 65535.';
  }
  if (d.connectTimeout && !(Number(d.connectTimeout) > 0)) {
    return 'Timeout must be a positive number of milliseconds.';
  }
  if (d.scheme === 'sftp' && d.auth === 'key' && !d.privateKeyPath.trim()) {
    return 'Private key path is required.';
  }
  return undefined;
}

/** Builds the settings entry. Secrets are never written to settings. */
function toConfig(d: FormData, original?: Connection): ConnectionConfig {
  const sftp = d.scheme === 'sftp';
  const auth = sftp ? d.auth : 'password';
  const config: ConnectionConfig = {
    scheme: d.scheme,
    label: d.label.trim() || undefined,
    host: d.host.trim(),
    port: d.port ? Number(d.port) : undefined,
    username: d.username.trim() || undefined,
    rootPath: d.rootPath.trim() || undefined,
    connectTimeout: d.connectTimeout ? Number(d.connectTimeout) : undefined,
  };
  if (sftp) {
    if (auth === 'key') {
      config.privateKeyPath = d.privateKeyPath.trim();
      // keep "prompt for passphrase" behaviour if it was configured
      if (original?.config.passphrase === true && !d.passphrase) {
        config.passphrase = true;
      }
    }
    if (auth === 'agent') {
      config.agent = d.agent.trim() || '$SSH_AUTH_SOCK';
    }
    config.interactiveAuth = d.interactiveAuth || undefined;
    config.algorithms = original?.config.algorithms;
  } else {
    if (d.scheme === 'ftps') {
      config.secure = d.implicitTls ? 'implicit' : undefined;
    }
    if (d.scheme !== 'ftp' || original?.config.secure) {
      config.rejectUnauthorized = d.rejectUnauthorized ? undefined : false;
    }
  }
  return config;
}

/** Temporary connection object used to test unsaved form data. */
function draftConnection(d: FormData, original?: Connection): Connection {
  const config = toConfig(d, original);
  const name = d.name.trim() || 'draft';
  return {
    id: original?.id ?? connectionId(name),
    name,
    config,
    scheme: d.scheme,
    port: config.port ?? defaultPort(d.scheme),
    rootPath: config.rootPath ?? '/',
    connectTimeout: config.connectTimeout ?? 10_000,
    target: original?.target ?? vscode.ConfigurationTarget.Global,
  };
}

export class ConnectionEditor {
  private static readonly panels = new Map<string, ConnectionEditor>();
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private original: Connection | undefined;

  static open(
    context: vscode.ExtensionContext,
    store: ConnectionStore,
    manager: ConnectionManager,
    conn?: Connection,
    duplicate = false
  ) {
    const key = conn && !duplicate ? conn.id : `new:${Date.now()}`;
    const existing = ConnectionEditor.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    ConnectionEditor.panels.set(key, new ConnectionEditor(context, store, manager, key, conn, duplicate));
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly key: string,
    conn: Connection | undefined,
    private readonly duplicate: boolean
  ) {
    this.original = duplicate ? undefined : conn;
    const title = conn && !duplicate ? `Remote FS: ${conn.name}` : 'Remote FS: New Connection';
    this.panel = vscode.window.createWebviewPanel('remotefs.connectionEditor', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m: InboundMessage) => this.onMessage(m, conn), null, this.disposables);
  }

  private dispose() {
    ConnectionEditor.panels.delete(this.key);
    this.disposables.forEach(d => d.dispose());
  }

  private post(message: unknown) {
    return this.panel.webview.postMessage(message);
  }

  private async onMessage(m: InboundMessage, source: Connection | undefined) {
    try {
      switch (m.type) {
        case 'ready': {
          const meta: FormMeta = {
            isNew: !this.original,
            hasSavedPassword: !!this.original && (await this.store.getSecret(this.original.id, 'password')) !== undefined,
            hasSavedPassphrase:
              !!this.original && (await this.store.getSecret(this.original.id, 'passphrase')) !== undefined,
            plaintextPassword: !!source?.config.password,
            workspaceScoped: source?.target === vscode.ConfigurationTarget.Workspace,
            hasAlgorithms: !!source?.config.algorithms,
          };
          await this.post({ type: 'init', data: toForm(source, this.duplicate), meta });
          break;
        }
        case 'browseKey': {
          const picked = await vscode.window.showOpenDialog({
            title: 'Select private key',
            canSelectMany: false,
            defaultUri: vscode.Uri.file(os.homedir() + '/.ssh'),
          });
          if (picked?.[0]) {
            await this.post({ type: 'keyPath', path: picked[0].fsPath });
          }
          break;
        }
        case 'openSettings':
          await vscode.commands.executeCommand('remotefs.openSettingsJson');
          break;
        case 'cancel':
          this.panel.dispose();
          break;
        case 'test':
          await this.test(m.data);
          break;
        case 'save':
          await this.save(m.data);
          break;
      }
    } catch (err) {
      logger.error(err instanceof Error ? err : String(err));
      await this.post({ type: 'status', ok: false, message: errorMessage(err) });
    }
  }

  private async test(d: FormData) {
    const error = validate({ ...d, name: d.name || 'draft' }, this.store, this.original);
    if (error && !/already exists/.test(error)) {
      await this.post({ type: 'status', ok: false, message: error });
      return;
    }
    await this.post({ type: 'status', busy: true, message: 'Connecting…' });
    const conn = draftConnection(d, this.original);
    const overrides = { password: d.password || undefined, passphrase: d.passphrase || undefined };
    // Only use keychain secrets of the connection being edited, and not the ones the user is about to forget.
    const real = this.store;
    const original = this.original;
    const store = Object.create(real, {
      getSecret: {
        value: async (id: string, kind: 'password' | 'passphrase') => {
          const forgotten = kind === 'password' ? d.forgetPassword : d.forgetPassphrase;
          return original && !forgotten ? real.getSecret(original.id, kind) : undefined;
        },
      },
    }) as ConnectionStore;
    const started = Date.now();
    let client;
    try {
      ({ client } = await connectWithPrompts(conn, store, createInteraction(this.context, conn.name), overrides));
      const rootRaw = conn.rootPath;
      const root = rootRaw.startsWith('/') ? rootRaw : await client.realpath(rootRaw.replace(/^~\/?/, '') || '.');
      const entries = await client.readdir(root);
      await this.post({
        type: 'status',
        ok: true,
        message: `Connected in ${Date.now() - started} ms — ${root} contains ${entries.length} entries.`,
      });
    } catch (err) {
      const cancelled = err instanceof RemoteError && err.code === 'ECANCELED';
      await this.post({ type: 'status', ok: false, message: cancelled ? 'Cancelled.' : errorMessage(err) });
    } finally {
      client?.close();
    }
  }

  private async save(d: FormData) {
    const error = validate(d, this.store, this.original);
    if (error) {
      await this.post({ type: 'status', ok: false, message: error });
      return;
    }
    const name = d.name.trim();
    const config = toConfig(d, this.original);
    const saved = await this.store.save(name, config, this.original);
    const id = saved.id;

    const usesPassword = d.scheme !== 'sftp' || d.auth === 'password';
    if (!usesPassword || d.forgetPassword || (d.password && !d.savePassword)) {
      await this.store.deleteSecret(id, 'password');
    } else if (d.password && d.savePassword) {
      await this.store.setSecret(id, 'password', d.password);
    }
    const usesKey = d.scheme === 'sftp' && d.auth === 'key';
    if (!usesKey || d.forgetPassphrase) {
      await this.store.deleteSecret(id, 'passphrase');
    } else if (d.passphrase) {
      await this.store.setSecret(id, 'passphrase', d.passphrase);
    }

    // credentials may have changed: force a fresh connection next time
    if (this.original) {
      this.manager.disconnect(this.original.id);
    }
    this.manager.disconnect(id);

    if (this.original && this.original.id !== id) {
      vscode.window.showWarningMessage(
        `Remote FS: "${this.original.name}" was renamed to "${name}". Workspace folders using ${this.original.scheme}://${this.original.id}/ must be re-added.`
      );
    } else {
      vscode.window.showInformationMessage(`Remote FS: connection "${name}" saved.`);
    }
    this.panel.dispose();
  }

  private html(): string {
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Remote FS Connection</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 24px 32px; max-width: 760px; }
  h1 { font-size: 1.5em; font-weight: 600; margin: 20px 0 4px; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
  fieldset { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; margin: 0 0 16px; padding: 12px 16px 4px; }
  legend { padding: 0 6px; font-weight: 600; }
  .row { display: grid; grid-template-columns: 170px 1fr; align-items: center; gap: 8px; margin-bottom: 10px; }
  .row > label { color: var(--vscode-foreground); }
  .row .hint { grid-column: 2; color: var(--vscode-descriptionForeground); font-size: 0.92em; margin-top: -6px; }
  .inline { display: flex; gap: 6px; }
  .inline input { flex: 1; }
  input[type=text], input[type=password], input[type=number], select {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 4px 6px; font: inherit; width: 100%; box-sizing: border-box;
  }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border-color: var(--vscode-dropdown-border); }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .check { display: flex; align-items: center; gap: 6px; grid-column: 2; }
  .radios { display: flex; gap: 16px; flex-wrap: wrap; }
  .radios label { display: flex; align-items: center; gap: 4px; }
  button { font: inherit; padding: 5px 14px; border-radius: 2px; border: 1px solid var(--vscode-button-border, transparent); cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .spacer { flex: 1; }
  #status { margin: 12px 0; padding: 8px 10px; border-radius: 3px; display: none; white-space: pre-wrap; }
  #status.ok { display: block; background: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); }
  #status.err { display: block; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
  #status.busy { display: block; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); }
  .note { color: var(--vscode-editorWarning-foreground); margin: -4px 0 10px; grid-column: 2; }
  .hidden { display: none !important; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
</style>
</head>
<body>
<h1 id="title">Connection</h1>
<div class="sub">Connection settings are saved in the <code>remotefs.remote</code> setting. Passwords and passphrases are stored in the OS keychain, never in settings.</div>

<form id="form" autocomplete="off">
<fieldset>
  <legend>General</legend>
  <div class="row"><label for="name">Name</label><input type="text" id="name" required placeholder="my-server"></div>
  <div class="row"><span></span><div class="hint">Used in URIs (e.g. <code>sftp://<span id="namePreview">name</span>/</code>). Letters, digits, <code>. _ -</code></div></div>
  <div class="row"><label for="label">Display label</label><input type="text" id="label" placeholder="optional"></div>
  <div class="row"><label for="scheme">Protocol</label>
    <select id="scheme">
      <option value="sftp">SFTP (SSH)</option>
      <option value="ftp">FTP</option>
      <option value="ftps">FTPS (FTP over TLS)</option>
    </select></div>
  <div class="row"><label for="host">Host</label><input type="text" id="host" required placeholder="example.com"></div>
  <div class="row"><label for="port">Port</label><input type="number" id="port" min="1" max="65535"></div>
  <div class="row"><label for="rootPath">Remote root path</label><input type="text" id="rootPath" placeholder="/ (absolute, or relative to the login directory, e.g. ~/www)"></div>
</fieldset>

<fieldset>
  <legend>Authentication</legend>
  <div class="row"><label for="username">Username</label><input type="text" id="username"></div>
  <div class="row sftp-only"><label>Method</label>
    <div class="radios">
      <label><input type="radio" name="auth" value="password"> Password</label>
      <label><input type="radio" name="auth" value="key"> Private key</label>
      <label><input type="radio" name="auth" value="agent"> SSH agent</label>
    </div></div>

  <div class="auth-password">
    <div class="row"><label for="password">Password</label><input type="password" id="password"></div>
    <div class="row"><span></span><div class="hint" id="passwordHint">Leave empty to be asked when connecting.</div></div>
    <div class="row hidden" id="plaintextNote"><span></span><div class="note">This connection has a plain-text password in settings.json: saving moves it to the keychain.</div></div>
    <div class="row"><label class="check"><input type="checkbox" id="savePassword"> Remember password in OS keychain</label></div>
    <div class="row hidden" id="forgetPasswordRow"><label class="check"><input type="checkbox" id="forgetPassword"> Forget saved password</label></div>
  </div>

  <div class="auth-key sftp-only">
    <div class="row"><label for="privateKeyPath">Private key</label>
      <div class="inline"><input type="text" id="privateKeyPath" placeholder="~/.ssh/id_ed25519"><button type="button" class="secondary" id="browseKey">Browse…</button></div></div>
    <div class="row"><label for="passphrase">Passphrase</label><input type="password" id="passphrase" placeholder="only for encrypted keys"></div>
    <div class="row"><span></span><div class="hint" id="passphraseHint">Stored in the OS keychain. Leave empty if the key is not encrypted (you will be asked if needed).</div></div>
    <div class="row hidden" id="forgetPassphraseRow"><label class="check"><input type="checkbox" id="forgetPassphrase"> Forget saved passphrase</label></div>
  </div>

  <div class="auth-agent sftp-only">
    <div class="row"><label for="agent">Agent socket</label><input type="text" id="agent" placeholder="$SSH_AUTH_SOCK (or 'pageant' on Windows)"></div>
  </div>

  <div class="row sftp-only"><label class="check"><input type="checkbox" id="interactiveAuth"> Keyboard-interactive authentication (2FA / OTP prompts)</label></div>
</fieldset>

<fieldset>
  <legend>Advanced</legend>
  <div class="row"><label for="connectTimeout">Timeout (ms)</label><input type="number" id="connectTimeout" min="1" placeholder="10000"></div>
  <div class="row ftps-only"><label class="check"><input type="checkbox" id="implicitTls"> Implicit TLS (legacy, usually port 990)</label></div>
  <div class="row ftps-only"><label class="check"><input type="checkbox" id="rejectUnauthorized"> Verify TLS certificate</label></div>
  <div class="row sftp-only hidden" id="algorithmsNote"><span></span><div class="hint">Custom <code>algorithms</code> are configured for this connection and will be preserved. <a id="openSettings">Edit in settings.json</a></div></div>
  <div class="row hidden" id="workspaceNote"><span></span><div class="hint">This connection is defined in the workspace settings.</div></div>
</fieldset>

<div id="status"></div>
<div class="actions">
  <button type="submit" id="save">Save</button>
  <button type="button" class="secondary" id="test">Test Connection</button>
  <span class="spacer"></span>
  <button type="button" class="secondary" id="cancel">Cancel</button>
</div>
</form>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const textFields = ['name', 'label', 'host', 'port', 'username', 'rootPath', 'connectTimeout', 'password', 'privateKeyPath', 'passphrase', 'agent'];
  const checkFields = ['savePassword', 'forgetPassword', 'forgetPassphrase', 'interactiveAuth', 'implicitTls', 'rejectUnauthorized'];
  let meta = {};

  function auth() {
    const r = document.querySelector('input[name=auth]:checked');
    return r ? r.value : 'password';
  }

  function collect() {
    const d = { scheme: $('scheme').value, auth: auth() };
    textFields.forEach(f => d[f] = $(f).value);
    checkFields.forEach(f => d[f] = $(f).checked);
    return d;
  }

  function show(selector, visible) {
    document.querySelectorAll(selector).forEach(el => el.classList.toggle('hidden', !visible));
  }

  function update() {
    const scheme = $('scheme').value;
    const sftp = scheme === 'sftp';
    const a = sftp ? auth() : 'password';
    show('.sftp-only', sftp);
    show('.ftps-only', scheme === 'ftps');
    show('.auth-password', a === 'password');
    show('.auth-key', sftp && a === 'key');
    show('.auth-agent', sftp && a === 'agent');
    $('algorithmsNote').classList.toggle('hidden', !(sftp && meta.hasAlgorithms));
    $('port').placeholder = sftp ? '22' : (scheme === 'ftps' && $('implicitTls').checked ? '990' : '21');
    $('namePreview').textContent = ($('name').value || 'name').toLowerCase();
    $('savePassword').disabled = !$('password').value;
  }

  function setStatus(kind, message) {
    const s = $('status');
    s.className = kind;
    s.textContent = message || '';
  }

  function setBusy(busy) {
    ['save', 'test'].forEach(id => $(id).disabled = busy);
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'init') {
      meta = m.meta;
      const d = m.data;
      textFields.forEach(f => $(f).value = d[f] ?? '');
      checkFields.forEach(f => $(f).checked = !!d[f]);
      $('scheme').value = d.scheme;
      document.querySelectorAll('input[name=auth]').forEach(r => r.checked = r.value === d.auth);
      $('title').textContent = meta.isNew ? 'New Connection' : 'Edit Connection — ' + d.name;
      $('forgetPasswordRow').classList.toggle('hidden', !meta.hasSavedPassword);
      $('forgetPassphraseRow').classList.toggle('hidden', !meta.hasSavedPassphrase);
      $('plaintextNote').classList.toggle('hidden', !meta.plaintextPassword);
      $('workspaceNote').classList.toggle('hidden', !meta.workspaceScoped);
      if (meta.hasSavedPassword) {
        $('password').placeholder = '•••••••• (saved in keychain — type to replace)';
        $('passwordHint').textContent = 'A password is saved in the keychain.';
      }
      if (meta.hasSavedPassphrase) {
        $('passphrase').placeholder = '•••••••• (saved in keychain — type to replace)';
      }
      update();
      $(meta.isNew ? 'name' : 'host').focus();
    } else if (m.type === 'keyPath') {
      $('privateKeyPath').value = m.path;
    } else if (m.type === 'status') {
      setBusy(!!m.busy);
      setStatus(m.busy ? 'busy' : (m.ok ? 'ok' : 'err'), m.message);
    }
  });

  document.addEventListener('input', update);
  document.addEventListener('change', update);
  $('form').addEventListener('submit', e => {
    e.preventDefault();
    setBusy(true);
    setStatus('busy', 'Saving…');
    vscode.postMessage({ type: 'save', data: collect() });
  });
  $('test').addEventListener('click', () => vscode.postMessage({ type: 'test', data: collect() }));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('browseKey').addEventListener('click', () => vscode.postMessage({ type: 'browseKey' }));
  $('openSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}
