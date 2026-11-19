'use strict';
// Checks the alias lookup order and the two alias stores with Obsidian stubbed out.
// Run: node tests/test-aliases.cjs
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

class FileSystemAdapter { constructor(base) { this.base = base; } getBasePath() { return this.base; } }
const notices = [];
const stub = { Plugin: class { constructor(app) { this.app = app; } }, PluginSettingTab: class {}, Setting: class {}, Menu: class {}, Modal: class {},
  Notice: class { constructor(text) { notices.push(text); } }, FileSystemAdapter };
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'obsidian' ? stub : load.call(this, request, ...rest); };
global.document = { querySelector: () => null, title: 'note - Docs - Obsidian' };
const Plugin = require('../main.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-aliases-'));
const here = path.join(base, 'here', 'Docs'), other = path.join(base, 'other', 'Docs'), plain = path.join(base, 'plain', 'Notes');
for (const dir of [path.join(here, '.config'), path.join(other, '.obsidian'), plain]) fs.mkdirSync(dir, { recursive: true });
const aliasFile = path.join(base, 'user', 'vault-aliases.json');

const plugin = new Plugin({ vault: { adapter: new FileSystemAdapter(here), configDir: '.config', getName: () => 'Docs' } });
plugin.settings = { aliasFile }; plugin.aliases = {}; plugin.originalLabel = null;

// Nothing stored anywhere: folder names.
plugin.readAliases();
assert.equal(plugin.displayName(here), 'Docs'); assert.equal(plugin.currentAlias(), null);

// Another vault's own alias is read from its standard config folder.
fs.writeFileSync(path.join(other, '.obsidian', 'vault-alias.json'), JSON.stringify({ version: 1, alias: ' Team wiki ' }));
assert.equal(plugin.displayName(other), 'Team wiki');
assert.equal(plugin.displayName(plain), 'Notes');

// A user alias wins over the vault's own alias, for any vault.
plugin.setAlias(other, 'My wiki');
assert.equal(plugin.displayName(other), 'My wiki');
assert.deepEqual(JSON.parse(fs.readFileSync(aliasFile, 'utf8')), { version: 1, aliases: { [other]: 'My wiki' } });

// Saving the user alias as this vault's own alias writes only into this vault's config folder.
plugin.setAlias(here, 'Work docs');
assert.equal(plugin.writeOwnVaultAlias(plugin.aliasFor(here)), true);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(here, '.config', 'vault-alias.json'), 'utf8')), { version: 1, alias: 'Work docs' });
assert.ok(!fs.existsSync(path.join(here, '.obsidian')), 'the configured config folder is used, not a new .obsidian');
assert.equal(JSON.parse(fs.readFileSync(path.join(other, '.obsidian', 'vault-alias.json'), 'utf8')).alias, ' Team wiki ', 'other vaults are not written');

// Reset: removing the user alias falls back to the vault's own alias, then to the folder name.
plugin.setAlias(here, 'Renamed by me');
assert.equal(plugin.currentAlias(), 'Renamed by me');
plugin.setAlias(here, '');
assert.equal(plugin.currentAlias(), 'Work docs'); assert.equal(plugin.displayName(here), 'Work docs');
plugin.setAlias(other, '');
assert.equal(plugin.displayName(other), 'Team wiki');
assert.deepEqual(JSON.parse(fs.readFileSync(aliasFile, 'utf8')).aliases, {});

// A fresh instance with no user aliases picks up the vault's own alias on load, and the title follows it.
const fresh = new Plugin({ vault: { adapter: new FileSystemAdapter(here), configDir: '.config', getName: () => 'Docs' } });
fresh.settings = { aliasFile: path.join(base, 'nobody', 'vault-aliases.json') }; fresh.aliases = {}; fresh.originalLabel = null;
fresh.readAliases(); fresh.applyTitle();
assert.equal(fresh.currentAlias(), 'Work docs'); assert.equal(document.title, 'note - Work docs - Obsidian');

// Renaming or removing the alias updates a title that already shows the old alias.
fresh.setAlias(here, 'Mine'); assert.equal(document.title, 'note - Mine - Obsidian');
fresh.setAlias(here, 'Mine 2'); assert.equal(document.title, 'note - Mine 2 - Obsidian');
fresh.setAlias(here, ''); assert.equal(document.title, 'note - Work docs - Obsidian');

// Titles Obsidian builds for separate windows carry the alias; an open Settings window follows changes.
const settingsDoc = { title: 'Settings - Docs - Obsidian' };
const hooks = [];
fresh.register = (fn) => hooks.push(fn);
fresh.app.title = 'Docs - Obsidian';
Object.getPrototypeOf(fresh.app).getAppTitle = function (t) { return t ? t + ' - ' + this.title : this.title; };
fresh.patchAppTitle();
assert.equal(fresh.app.getAppTitle('Settings'), 'Settings - Work docs - Obsidian');
fresh.app.setting = { popout: { win: { closed: false, document: settingsDoc } } };
fresh.setAlias(here, 'Mine 3');
assert.equal(settingsDoc.title, 'Settings - Mine 3 - Obsidian'); assert.equal(document.title, 'note - Mine 3 - Obsidian');
fresh.onunload(); hooks.forEach((fn) => fn());
assert.equal(settingsDoc.title, 'Settings - Docs - Obsidian'); assert.equal(document.title, 'note - Docs - Obsidian');
assert.equal(fresh.app.getAppTitle('Settings'), 'Settings - Docs - Obsidian');
fresh.setAlias(here, '');

// An empty or damaged vault alias file is ignored; an empty alias is never written.
fs.writeFileSync(path.join(other, '.obsidian', 'vault-alias.json'), '{ not json');
const error = console.error; console.error = () => {};
assert.equal(plugin.displayName(other), 'Docs'); console.error = error;
assert.equal(plugin.writeOwnVaultAlias('   '), false);

assert.deepEqual(notices, []);
fs.rmSync(base, { recursive: true, force: true });
console.log('PASS: lookup order, vault-own alias store, reset fallback, window titles');
