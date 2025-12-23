var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_state = require("@codemirror/state");
var import_view = require("@codemirror/view");
var DEFAULT_SETTINGS = {
  serverUrl: "ws://localhost:8000",
  clientId: "",
  fileVersions: {}
};
var RemoteUpdate = import_state.Annotation.define();
var updateCursorEffect = import_state.StateEffect.define();
var removeCursorEffect = import_state.StateEffect.define();
var CursorWidget = class extends import_view.WidgetType {
  constructor(color, label) {
    super();
    this.color = color;
    this.label = label;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "remote-cursor";
    wrap.style.borderLeftColor = this.color;
    const label = document.createElement("span");
    label.className = "remote-cursor-label";
    label.textContent = this.label;
    label.style.backgroundColor = this.color;
    wrap.appendChild(label);
    return wrap;
  }
};
var cursorField = import_state.StateField.define({
  create() {
    return import_view.Decoration.none;
  },
  update(cursors, tr) {
    try {
      try {
        cursors = cursors.map(tr.changes);
      } catch (e) {
        return import_view.Decoration.none;
      }
      for (let e of tr.effects) {
        if (e.is(updateCursorEffect)) {
          if (e.value.pos < 0 || e.value.pos > tr.newDoc.length) continue;
          const deco = import_view.Decoration.widget({
            widget: new CursorWidget(e.value.color, e.value.clientId),
            side: 0
          }).range(e.value.pos);
          cursors = cursors.update({
            filter: (from, to, value) => value.widget.label !== e.value.clientId,
            add: [deco]
          });
        }
        if (e.is(removeCursorEffect)) {
          cursors = cursors.update({ filter: (from, to, value) => value.widget.label !== e.value });
        }
      }
      return cursors;
    } catch (e) {
      return import_view.Decoration.none;
    }
  },
  provide: (f) => import_view.EditorView.decorations.from(f)
});
var SyncPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    __publicField(this, "settings");
    __publicField(this, "fileSocket", null);
    __publicField(this, "vaultSocket", null);
    __publicField(this, "vaultMessageQueue", []);
    __publicField(this, "activeClientId");
    __publicField(this, "color", "#" + Math.floor(Math.random() * 16777215).toString(16));
    __publicField(this, "statusBarItem");
    __publicField(this, "isRequestingFullSync", false);
    __publicField(this, "lastLocalChangeTime", 0);
    __publicField(this, "isApplyingRemoteVaultAction", false);
  }
  async onload() {
    console.log("CyberSync: Plugin Loading...");
    await this.loadSettings();
    this.updateActiveClientId();
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("cybersync-statusbar");
    this.statusBarItem.style.cursor = "pointer";
    this.statusBarItem.title = "Click to Reconnect";
    this.statusBarItem.addEventListener("click", async () => {
      await this.forceReconnect();
    });
    this.registerInterval(
      window.setInterval(() => {
        this.updateStatusBar();
      }, 5e3)
    );
    this.updateStatusBar("disconnected");
    this.addSettingTab(new CyberSyncSettingTab(this.app, this));
    this.connectVaultSocket();
    this.registerEvent(this.app.vault.on("create", (file) => this.onLocalFileCreate(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onLocalFileDelete(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onLocalFileRename(file, oldPath)));
    const pluginInstance = this;
    const syncExtension = import_view.EditorView.updateListener.of((update) => {
      var _a;
      if (((_a = pluginInstance.fileSocket) == null ? void 0 : _a.readyState) !== WebSocket.OPEN) return;
      if (update.transactions.some((tr) => tr.annotation(RemoteUpdate))) return;
      if (update.docChanged) {
        pluginInstance.lastLocalChangeTime = Date.now();
        pluginInstance.fileSocket.send(JSON.stringify({
          type: "text_change",
          changes: update.changes.toJSON(),
          clientId: pluginInstance.activeClientId
        }));
      }
      if (update.selectionSet) {
        if (!update.transactions.some((tr) => tr.annotation(RemoteUpdate))) {
          const pos = update.state.selection.main.head;
          pluginInstance.fileSocket.send(JSON.stringify({
            type: "cursor",
            pos,
            color: pluginInstance.color,
            clientId: pluginInstance.activeClientId
          }));
        }
      }
    });
    this.registerEditorExtension([cursorField, syncExtension]);
    this.app.workspace.on("file-open", (file) => {
      if (file) this.connectFileSocket(file.path);
      else {
        if (this.fileSocket) this.fileSocket.close();
        this.fileSocket = null;
        this.updateStatusBar();
      }
    });
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) this.connectFileSocket(activeFile.path);
  }
  async forceReconnect() {
    new import_obsidian.Notice("CyberSync: Reconnecting...");
    if (this.vaultSocket) {
      this.vaultSocket.close();
      this.vaultSocket = null;
    }
    if (this.fileSocket) {
      this.fileSocket.close();
      this.fileSocket = null;
    }
    this.updateStatusBar("disconnected");
    setTimeout(() => {
      this.connectVaultSocket();
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) this.connectFileSocket(activeFile.path);
    }, 500);
  }
  updateStatusBar(forceStatus) {
    var _a, _b;
    this.statusBarItem.empty();
    const icon = this.statusBarItem.createSpan({ cls: "cybersync-status-icon" });
    let text = "";
    let color = "";
    if (forceStatus) {
      if (forceStatus === "connected") {
        text = "\u25CF CyberSync: OK";
        color = "var(--text-success)";
      } else if (forceStatus === "syncing") {
        text = "\u21BB CyberSync: Sync";
        color = "var(--text-warning)";
      } else if (forceStatus === "error") {
        text = "\xD7 CyberSync: Err";
        color = "var(--text-error)";
      } else {
        text = "\u25CF CyberSync: Off";
        color = "var(--text-muted)";
      }
    } else {
      const vaultReady = ((_a = this.vaultSocket) == null ? void 0 : _a.readyState) === WebSocket.OPEN;
      const fileReady = ((_b = this.fileSocket) == null ? void 0 : _b.readyState) === WebSocket.OPEN;
      const hasActiveFile = this.app.workspace.getActiveFile() !== null;
      if (vaultReady && (fileReady || !hasActiveFile)) {
        text = "\u25CF CyberSync: OK";
        color = "var(--text-success)";
      } else if (vaultReady && hasActiveFile && !fileReady) {
        text = "\u25CF CyberSync: No File";
        color = "var(--text-warning)";
      } else if (!vaultReady && fileReady) {
        text = "\u25CF CyberSync: No Vault";
        color = "var(--text-warning)";
      } else if (!vaultReady && !fileReady) {
        text = "\xD7 CyberSync: Off";
        color = "var(--text-muted)";
      } else {
        text = "\u25CF CyberSync: Check";
        color = "var(--text-muted)";
      }
    }
    icon.setText(text);
    icon.style.color = color;
  }
  sendVaultMessage(msg) {
    const json = JSON.stringify(msg);
    if (this.vaultSocket && this.vaultSocket.readyState === WebSocket.OPEN) {
      this.vaultSocket.send(json);
    } else {
      this.vaultMessageQueue.push(json);
    }
  }
  onLocalFileCreate(file) {
    if (this.isApplyingRemoteVaultAction) return;
    if (!(file instanceof import_obsidian.TFile)) return;
    console.log("CyberSync: Local Create Detected ->", file.path);
    this.sendVaultMessage({ type: "file_created", path: file.path });
  }
  onLocalFileDelete(file) {
    if (this.isApplyingRemoteVaultAction) return;
    if (!(file instanceof import_obsidian.TFile)) return;
    console.log("CyberSync: Local Delete Detected ->", file.path);
    this.sendVaultMessage({ type: "file_deleted", path: file.path });
  }
  onLocalFileRename(file, oldPath) {
    if (this.isApplyingRemoteVaultAction) return;
    if (!(file instanceof import_obsidian.TFile)) return;
    console.log("CyberSync: Local Rename Detected ->", oldPath, "to", file.path);
    this.sendVaultMessage({ type: "file_renamed", path: file.path, oldPath });
  }
  connectVaultSocket() {
    const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
    const url = `${baseUrl}/ws?file_id=__global__&client_id=${encodeURIComponent(this.activeClientId)}&t=${Date.now()}`;
    try {
      if (this.vaultSocket) {
        this.vaultSocket.close();
      }
      this.vaultSocket = new WebSocket(url);
      this.vaultSocket.onopen = () => {
        var _a;
        console.log("CyberSync: \u{1F30D}\u2705 Connected to Global Vault!");
        this.updateStatusBar();
        while (this.vaultMessageQueue.length > 0) {
          const msg = this.vaultMessageQueue.shift();
          if (msg) (_a = this.vaultSocket) == null ? void 0 : _a.send(msg);
        }
      };
      this.vaultSocket.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        if (data.clientId === this.activeClientId) return;
        console.log("CyberSync: \u{1F30D} Received Vault Event:", data.type, data.path);
        this.isApplyingRemoteVaultAction = true;
        try {
          if (data.type === "vault_sync_init") {
            const serverFiles = data.files || [];
            console.log("CyberSync: Initial Sync. Files:", serverFiles.length);
            for (const path of serverFiles) {
              if (!this.app.vault.getAbstractFileByPath(path)) {
                try {
                  await this.createFolderRecursively(path);
                  await this.app.vault.create(path, "");
                  console.log("CyberSync: Synced missing file:", path);
                } catch (e) {
                  console.warn("Failed to sync file:", path, e);
                }
              }
            }
          } else if (data.type === "file_created") {
            if (!this.app.vault.getAbstractFileByPath(data.path)) {
              await this.createFolderRecursively(data.path);
              await this.app.vault.create(data.path, "");
              console.log("CyberSync: Remote Created ->", data.path);
            }
          } else if (data.type === "file_deleted") {
            const file = this.app.vault.getAbstractFileByPath(data.path);
            if (file) {
              await this.app.vault.delete(file);
              console.log("CyberSync: Remote Deleted ->", data.path);
            }
          } else if (data.type === "file_renamed") {
            const file = this.app.vault.getAbstractFileByPath(data.oldPath);
            if (file) {
              await this.createFolderRecursively(data.path);
              await this.app.vault.rename(file, data.path);
              console.log("CyberSync: Remote Renamed ->", data.oldPath, "to", data.path);
            }
          }
        } catch (e) {
          console.error("CyberSync: Error applying vault action:", e);
        } finally {
          this.isApplyingRemoteVaultAction = false;
        }
      };
      this.vaultSocket.onclose = () => {
        console.log("CyberSync: \u{1F30D} Vault Socket Closed");
        this.updateStatusBar("disconnected");
      };
      this.vaultSocket.onerror = (e) => {
        console.error("CyberSync: \u{1F30D} Vault Socket Error", e);
        this.updateStatusBar("error");
      };
    } catch (e) {
      console.error("CyberSync: Vault Connect Failed", e);
      this.updateStatusBar("error");
    }
  }
  async createFolderRecursively(path) {
    const folders = path.split("/").slice(0, -1);
    if (folders.length === 0) return;
    let current = "";
    for (const folder of folders) {
      current = current === "" ? folder : current + "/" + folder;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
  connectFileSocket(filepath) {
    if (this.fileSocket) {
      this.fileSocket.close();
      this.fileSocket = null;
    }
    const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
    const url = `${baseUrl}/ws?file_id=${encodeURIComponent(filepath)}&client_id=${encodeURIComponent(this.activeClientId)}`;
    try {
      this.fileSocket = new WebSocket(url);
      this.fileSocket.onopen = () => {
        console.log("CyberSync: File Connected:", filepath);
        this.updateStatusBar("connected");
        const ver = this.settings.fileVersions[filepath] || 0;
        this.fileSocket.send(JSON.stringify({
          type: "handshake",
          version: ver
        }));
      };
      this.fileSocket.onmessage = async (event) => {
        var _a, _b;
        const msg = JSON.parse(event.data);
        if (msg.clientId === this.activeClientId && msg.type !== "ack") return;
        if (msg.type === "text_change") {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.path !== filepath) return;
          const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
          if (!view) return;
          const cm = view.editor.cm;
          if (cm) {
            try {
              const changeSet = import_state.ChangeSet.fromJSON(msg.changes);
              cm.dispatch({
                changes: changeSet,
                annotations: [RemoteUpdate.of(true)]
              });
              this.settings.fileVersions[filepath] = msg.version;
              await this.saveSettings();
            } catch (e) {
              console.error("CyberSync: Failed to apply patches", e);
            }
          }
        } else if (msg.type === "ack") {
          this.settings.fileVersions[filepath] = msg.version;
          await this.saveSettings();
        } else if (msg.type === "full_sync") {
          const file = this.app.workspace.getActiveFile();
          if (file && file.path === filepath) {
            const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
            if (view) {
              view.editor.setValue(msg.content);
              this.settings.fileVersions[filepath] = msg.version;
              await this.saveSettings();
            }
          }
        } else if (msg.type === "cursor") {
          const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
          const cm = (_a = view == null ? void 0 : view.editor) == null ? void 0 : _a.cm;
          if (cm) {
            cm.dispatch({
              effects: updateCursorEffect.of({
                pos: msg.pos,
                clientId: msg.clientId,
                color: msg.color
              })
            });
          }
        } else if (msg.type === "disconnect") {
          const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
          const cm = (_b = view == null ? void 0 : view.editor) == null ? void 0 : _b.cm;
          if (cm) {
            cm.dispatch({
              effects: removeCursorEffect.of(msg.clientId)
            });
          }
        }
      };
      this.fileSocket.onclose = () => {
        this.updateStatusBar();
      };
    } catch (e) {
      console.error("CyberSync: File Connect Error", e);
    }
  }
  updateActiveClientId() {
    if (!this.settings.clientId) {
      this.settings.clientId = "client-" + Math.random().toString(36).substr(2, 9);
      this.saveSettings();
    }
    this.activeClientId = this.settings.clientId;
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
var CyberSyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    __publicField(this, "plugin");
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "CyberSync Settings" });
    new import_obsidian.Setting(containerEl).setName("Server URL").setDesc("Address of the python server").addText((text) => text.setPlaceholder("ws://localhost:8000").setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
      this.plugin.settings.serverUrl = value;
      await this.plugin.saveSettings();
      this.plugin.forceReconnect();
    }));
    new import_obsidian.Setting(containerEl).setName("Client ID").setDesc("Unique ID for this device").addText((text) => text.setPlaceholder("client-123").setValue(this.plugin.settings.clientId).onChange(async (value) => {
      this.plugin.settings.clientId = value;
      await this.plugin.saveSettings();
      this.plugin.updateActiveClientId();
      this.plugin.forceReconnect();
    }));
  }
};
