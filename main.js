/*
 * Vault Aliases — display names for Obsidian vaults.
 *
 * Nothing on disk is renamed. Aliases are kept in one shared JSON file outside
 * every vault (default: vault-aliases.json in Obsidian's per-user settings
 * folder, e.g. %APPDATA%\obsidian on Windows) so that every vault
 * with this plugin enabled shows the same names for all vaults.
 *
 * Shared file format: { "version": 1, "aliases": { "<vault path>": "<alias>" } }
 *
 * Relies on two Obsidian internals (checked against the installed build):
 *   - ipcRenderer "vault-list" / "vault" / "vault-open"
 *   - the sidebar element .workspace-drawer-vault-switcher / .workspace-drawer-vault-name
 */
'use strict';

const { Plugin, PluginSettingTab, Setting, Menu, Modal, Notice, FileSystemAdapter } = require('obsidian');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Default location: next to Obsidian's own per-user settings (the folder holding obsidian.json),
// which is outside every vault and the same for all of them.
function defaultAliasFile() {
  const home = os.homedir();
  const dir = process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obsidian')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'obsidian')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obsidian');
  return path.join(dir, 'vault-aliases.json');
}

const VAULT_ALIAS_FILE = 'vault-alias.json';

const DEFAULT_SETTINGS = {
  aliasFile: defaultAliasFile(),
};

function ipc() {
  return (window.electron && window.electron.ipcRenderer) || require('electron').ipcRenderer;
}

function normPath(p) {
  return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
}

class VaultAliasesPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.aliases = {};
    this.originalLabel = null;
    this.readAliases();

    this.addSettingTab(new VaultAliasesSettingTab(this.app, this));

    // Take over the vault switcher click before Obsidian's own handler runs.
    this.registerDomEvent(document, 'click', (evt) => this.onDocumentClick(evt), { capture: true });

    this.app.workspace.onLayoutReady(() => this.applyAll());
    this.registerEvent(this.app.workspace.on('layout-change', () => this.applyLabel()));

    // Keep the window title on the alias whenever Obsidian rewrites it.
    this.titleObserver = new MutationObserver(() => this.applyTitle());
    const titleEl = document.querySelector('head > title');
    if (titleEl) this.titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  onunload() {
    if (this.titleObserver) this.titleObserver.disconnect();
    const alias = this.currentAlias();
    const name = this.currentBasename();
    const label = document.querySelector('.workspace-drawer-vault-name');
    if (label && this.originalLabel !== null) label.setText(this.originalLabel);
    if (alias && alias !== name) document.title = this.swapTitle(document.title, alias, name);
  }

  // ---- shared alias file ----

  readAliases() {
    const cur = this.currentPath();
    this.ownVaultAlias = cur ? this.readVaultAlias(cur) : null;
    try {
      const raw = fs.readFileSync(this.settings.aliasFile, 'utf8');
      const data = JSON.parse(raw);
      const out = {};
      for (const [p, a] of Object.entries((data && data.aliases) || {})) {
        if (typeof a === 'string' && a.trim()) out[normPath(p)] = { path: p, alias: a.trim() };
      }
      this.aliases = out;
      this.readError = null;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.readError = e.message;
        console.error('[vault-aliases] cannot read', this.settings.aliasFile, e);
      } else {
        this.readError = null;
      }
      this.aliases = this.aliases || {};
    }
    return this.aliases;
  }

  writeAliases() {
    const file = this.settings.aliasFile;
    const aliases = {};
    for (const v of Object.values(this.aliases)) aliases[v.path] = v.alias;
    const body = JSON.stringify({ version: 1, aliases }, null, 2) + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
  }

  setAlias(vaultPath, alias) {
    const key = normPath(vaultPath);
    this.readAliases(); // merge with edits made from other vaults
    if (alias && alias.trim()) this.aliases[key] = { path: vaultPath, alias: alias.trim() };
    else delete this.aliases[key];
    try {
      this.writeAliases();
    } catch (e) {
      new Notice('Vault Aliases: could not save aliases — ' + e.message);
      console.error('[vault-aliases] write failed', e);
      return;
    }
    this.applyAll();
  }

  // The user's own alias for a vault, from the shared alias file.
  aliasFor(vaultPath) {
    const hit = this.aliases[normPath(vaultPath)];
    return hit ? hit.alias : null;
  }

  // ---- the vault's own alias ----
  // Each vault may carry one alias for itself in <vault>/<config folder>/vault-alias.json:
  // { "version": 1, "alias": "<name>" }. It travels with the vault and is used when the
  // user has no alias of their own for it.

  vaultAliasFile(vaultPath) {
    const cur = this.currentPath();
    // Another vault's config folder name is not known from here; assume the standard one.
    const configDir = cur && normPath(cur) === normPath(vaultPath) ? this.app.vault.configDir : '.obsidian';
    return path.join(vaultPath, configDir, VAULT_ALIAS_FILE);
  }

  readVaultAlias(vaultPath) {
    try {
      const data = JSON.parse(fs.readFileSync(this.vaultAliasFile(vaultPath), 'utf8'));
      return data && typeof data.alias === 'string' && data.alias.trim() ? data.alias.trim() : null;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[vault-aliases] cannot read the vault alias of', vaultPath, e);
      return null;
    }
  }

  // Only ever written for the vault this plugin instance runs in.
  writeOwnVaultAlias(alias) {
    const cur = this.currentPath();
    if (!cur || !alias || !alias.trim()) return false;
    const file = this.vaultAliasFile(cur);
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, alias: alias.trim() }, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      new Notice('Vault Aliases: could not save the vault alias — ' + e.message);
      console.error('[vault-aliases] vault alias write failed', e);
      return false;
    }
    this.ownVaultAlias = alias.trim();
    this.applyAll();
    return true;
  }

  // User alias first, then the vault's own alias, then the folder name.
  displayName(vaultPath) {
    return this.aliasFor(vaultPath) || this.readVaultAlias(vaultPath) || path.basename(vaultPath);
  }

  // ---- vault info ----

  vaultList() {
    const list = ipc().sendSync('vault-list') || {};
    return Object.keys(list).map((id) => ({ id, path: list[id].path }));
  }

  currentPath() {
    const a = this.app.vault.adapter;
    return a instanceof FileSystemAdapter ? a.getBasePath() : null;
  }

  currentBasename() {
    return this.app.vault.getName();
  }

  currentAlias() {
    const p = this.currentPath();
    return p ? this.aliasFor(p) || this.ownVaultAlias || null : null;
  }

  // ---- UI patching ----

  onDocumentClick(evt) {
    const target = evt.target;
    if (!(target instanceof Element)) return;
    const switcher = target.closest('.workspace-drawer-vault-switcher');
    if (!switcher) return;
    evt.stopImmediatePropagation();
    evt.preventDefault();
    if (switcher.classList.contains('has-active-menu')) return;
    this.readAliases();
    this.showSwitcherMenu(evt, switcher);
  }

  showSwitcherMenu(evt, switcher) {
    let current = null;
    try { current = ipc().sendSync('vault').path; } catch (e) { current = this.currentPath(); }
    const menu = new Menu();
    for (const v of this.vaultList()) {
      const isCurrent = current && normPath(current) === normPath(v.path);
      menu.addItem((item) => item
        .setTitle(this.displayName(v.path))
        .setChecked(!!isCurrent)
        .onClick(() => {
          if (isCurrent) return;
          if (ipc().sendSync('vault-open', v.path, false) !== true) {
            new Notice('Failed to open vault: ' + v.path);
          }
        }));
    }
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle('Manage vaults...')
      .setIcon('open-vault')
      .onClick(() => this.app.openVaultChooser()));
    if (typeof menu.setParentElement === 'function') menu.setParentElement(switcher);
    menu.showAtMouseEvent(evt);
  }

  applyAll() {
    this.applyLabel();
    this.applyTitle();
  }

  applyLabel() {
    const label = document.querySelector('.workspace-drawer-vault-name');
    if (!label) return;
    if (this.originalLabel === null) this.originalLabel = this.currentBasename();
    const want = this.currentAlias() || this.originalLabel;
    if (label.textContent !== want) label.setText(want);
  }

  swapTitle(title, from, to) {
    // Obsidian's title is "<note> - <vault> - Obsidian vX"; replace the vault segment.
    const parts = title.split(' - ');
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i] === from) { parts[i] = to; return parts.join(' - '); }
    }
    return title;
  }

  applyTitle() {
    const alias = this.currentAlias();
    const name = this.currentBasename();
    if (!alias || alias === name) return;
    const next = this.swapTitle(document.title, name, alias);
    if (next !== document.title) document.title = next;
  }
}

class VaultAliasesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();
    plugin.readAliases();

    const intro = containerEl.createEl('p');
    for (const line of ['Set display names for vaults.', 'Folders and paths are not changed.', 'Aliases are chosen in this priority:', "Your own alias > Vault's own alias > Folder name"]) {
      intro.createDiv({ text: line });
    }
    const hint = containerEl.createEl('p', { cls: 'setting-item-description' });
    hint.appendText("To remove a vault's own alias, delete ");
    hint.createEl('code', { text: 'vault/' + this.app.vault.configDir + '/' + VAULT_ALIAS_FILE });

    new Setting(containerEl)
      .setName('Alias file')
      .setDesc('Shared by every vault that has this plugin enabled, so all of them show the same names.')
      .addText((t) => t
        .setValue(plugin.settings.aliasFile)
        .onChange(async (v) => {
          plugin.settings.aliasFile = v.trim() || DEFAULT_SETTINGS.aliasFile;
          await plugin.saveData(plugin.settings);
        }))
      .addButton((b) => b.setButtonText('Reload').onClick(() => {
        plugin.readAliases();
        plugin.applyAll();
        this.display();
      }));

    if (plugin.readError) {
      containerEl.createEl('p', { text: 'Could not read the alias file: ' + plugin.readError, cls: 'mod-warning' });
    }

    new Setting(containerEl).setName('Vaults').setHeading();

    const current = plugin.currentPath();
    for (const v of plugin.vaultList()) {
      const folder = path.basename(v.path);
      const isCurrent = current && normPath(current) === normPath(v.path);
      let vaultAlias = plugin.readVaultAlias(v.path);
      let text = null, resetBtn = null, saveBtn = null;
      const row = new Setting(containerEl).setName(folder + (isCurrent ? ' (this vault)' : ''));
      // Buttons and hints follow the stored state; the row is updated in place so that a
      // click on a button right after typing is not lost to a redraw.
      const refresh = () => {
        const mine = plugin.aliasFor(v.path);
        row.setDesc(v.path + (vaultAlias ? ' · vault alias: ' + vaultAlias : ''));
        if (text) text.setPlaceholder(vaultAlias || folder);
        if (resetBtn) resetBtn.setDisabled(!mine);
        if (saveBtn) saveBtn.setDisabled(!mine || mine === vaultAlias);
      };
      row.addText((t) => {
        text = t;
        t.setValue(plugin.aliasFor(v.path) || '');
        // Save when the field loses focus or Enter is pressed, not on every keystroke.
        const commit = () => {
          if ((plugin.aliasFor(v.path) || '') !== t.getValue().trim()) plugin.setAlias(v.path, t.getValue());
          refresh();
        };
        t.inputEl.addEventListener('blur', commit);
        t.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') t.inputEl.blur(); });
      });
      row.addExtraButton((b) => {
        resetBtn = b;
        b.setIcon('rotate-ccw')
          .setTooltip(vaultAlias ? "Reset to the vault's own alias" : 'Reset to the folder name')
          .onClick(() => {
            plugin.setAlias(v.path, '');
            text.setValue('');
            refresh();
          });
      });
      if (isCurrent) {
        row.addExtraButton((b) => {
          saveBtn = b;
          b.setIcon('upload')
            .setTooltip("Save this name as the vault's own alias (stored in this vault's config folder)")
            .onClick(() => {
              const mine = plugin.aliasFor(v.path);
              if (!mine) return;
              const save = () => {
                if (plugin.writeOwnVaultAlias(mine)) {
                  vaultAlias = mine;
                  new Notice("Vault Aliases: saved as this vault's own alias");
                }
                refresh();
              };
              // Replacing an alias the vault already carries needs a yes; a first one does not.
              const existing = plugin.readVaultAlias(v.path);
              if (existing && existing !== mine) new ChangeAliasModal(this.app, existing, mine, save).open();
              else save();
            });
        });
      }
      refresh();
    }
  }
}

// Asks before the vault's own alias is replaced by a different one.
class ChangeAliasModal extends Modal {
  constructor(app, oldAlias, newAlias, onConfirm) {
    super(app);
    this.oldAlias = oldAlias;
    this.newAlias = newAlias;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    this.setTitle('Change alias?');
    this.contentEl.createEl('p', { text: this.oldAlias + ' → ' + this.newAlias });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Change').setCta().onClick(() => { this.close(); this.onConfirm(); }))
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = VaultAliasesPlugin;
