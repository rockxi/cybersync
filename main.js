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
  fileVersions: {},
  lastSyncedHash: {},
  offlineChanges: {}
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
          cursors = cursors.update({
            filter: (from, to, value) => value.widget.label !== e.value
          });
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
    __publicField(this, "globalSocket", null);
    __publicField(this, "reconnectTimeout", null);
    __publicField(this, "activeClientId");
    __publicField(this, "color", "#" + Math.floor(Math.random() * 16777215).toString(16));
    __publicField(this, "statusBarItem");
    __publicField(this, "isOnline", false);
    __publicField(this, "isApplyingRemoteAction", false);
    __publicField(this, "pendingLocalChanges", /* @__PURE__ */ new Map());
  }
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(36);
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
    this.connectGlobalSocket();
    this.registerEvent(
      this.app.vault.on("create", (file) => this.onLocalFileCreate(file))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.onLocalFileDelete(file))
    );
    this.registerEvent(
      this.app.vault.on(
        "rename",
        (file, oldPath) => this.onLocalFileRename(file, oldPath)
      )
    );
    const pluginInstance = this;
    const syncExtension = import_view.EditorView.updateListener.of((update) => {
      var _a;
      if (!pluginInstance.isOnline) {
        const file2 = pluginInstance.app.workspace.getActiveFile();
        if (file2 && update.docChanged) {
          pluginInstance.settings.offlineChanges[file2.path] = true;
          pluginInstance.saveSettings();
        }
        return;
      }
      if (((_a = pluginInstance.globalSocket) == null ? void 0 : _a.readyState) !== WebSocket.OPEN) return;
      if (update.transactions.some((tr) => tr.annotation(RemoteUpdate))) return;
      const file = pluginInstance.app.workspace.getActiveFile();
      if (!file) return;
      if (update.docChanged) {
        const newContent = update.state.doc.toString();
        pluginInstance.globalSocket.send(
          JSON.stringify({
            type: "text_change",
            filePath: file.path,
            changes: update.changes.toJSON(),
            clientId: pluginInstance.activeClientId,
            version: pluginInstance.settings.fileVersions[file.path] || 0
          })
        );
        pluginInstance.settings.lastSyncedHash[file.path] = pluginInstance.hashString(newContent);
      }
      if (update.selectionSet) {
        const pos = update.state.selection.main.head;
        pluginInstance.globalSocket.send(
          JSON.stringify({
            type: "cursor",
            filePath: file.path,
            pos,
            color: pluginInstance.color,
            clientId: pluginInstance.activeClientId
          })
        );
      }
    });
    this.registerEditorExtension([cursorField, syncExtension]);
    this.app.workspace.on("file-open", (file) => {
      var _a;
      if (file) {
        const wasChangedOffline = this.settings.offlineChanges[file.path];
        if (wasChangedOffline && this.isOnline) {
          (_a = this.globalSocket) == null ? void 0 : _a.send(
            JSON.stringify({
              type: "sync_offline_changes",
              filePath: file.path,
              clientId: this.activeClientId
            })
          );
        }
      }
    });
  }
  onunload() {
    console.log("CyberSync: Plugin Unloading...");
    if (this.globalSocket) {
      this.globalSocket.close();
      this.globalSocket = null;
    }
    if (this.reconnectTimeout) {
      window.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }
  async forceReconnect() {
    new import_obsidian.Notice("CyberSync: Reconnecting...");
    if (this.globalSocket) {
      this.globalSocket.close();
      this.globalSocket = null;
    }
    this.isOnline = false;
    this.updateStatusBar("disconnected");
    setTimeout(() => {
      this.connectGlobalSocket();
    }, 500);
  }
  updateStatusBar(forceStatus) {
    this.statusBarItem.empty();
    const icon = this.statusBarItem.createSpan({
      cls: "cybersync-status-icon"
    });
    let text = "";
    let color = "";
    if (forceStatus === "connected") {
      text = "\u25CF CyberSync: OK";
      color = "var(--text-success)";
    } else if (forceStatus === "disconnected") {
      text = "\xD7 CyberSync: Off";
      color = "var(--text-muted)";
    } else if (this.isOnline) {
      text = "\u25CF CyberSync: OK";
      color = "var(--text-success)";
    } else {
      text = "\u26A0\uFE0F CyberSync: Offline";
      color = "var(--text-warning)";
    }
    icon.setText(text);
    icon.style.color = color;
  }
  onLocalFileCreate(file) {
    var _a;
    if (this.isApplyingRemoteAction) return;
    if (!(file instanceof import_obsidian.TFile)) return;
    console.log("CyberSync: Local Create ->", file.path);
    if (this.isOnline) {
      (_a = this.globalSocket) == null ? void 0 : _a.send(
        JSON.stringify({
          type: "file_created",
          filePath: file.path,
          clientId: this.activeClientId
        })
      );
    } else {
      this.settings.offlineChanges[file.path] = true;
      this.saveSettings();
    }
  }
  onLocalFileDelete(file) {
    var _a;
    if (this.isApplyingRemoteAction) return;
    if (!(file instanceof import_obsidian.TFile)) return;
    console.log("CyberSync: Local Delete ->", file.path);
    if (this.isOnline) {
      (_a = this.globalSocket) == null ? void 0 : _a.send(
        JSON.stringify({
          type: "file_deleted",
          filePath: file.path,
          clientId: this.activeClientId
        })
      );
    }
  }
  onLocalFileRename(file, oldPath) {
    var _a;
    if (this.isApplyingRemoteAction) return;
    if (!(file instanceof import_obsidian.TFile)) return;
    console.log("CyberSync: Local Rename ->", oldPath, "to", file.path);
    if (this.isOnline) {
      (_a = this.globalSocket) == null ? void 0 : _a.send(
        JSON.stringify({
          type: "file_renamed",
          filePath: file.path,
          oldPath,
          clientId: this.activeClientId
        })
      );
    }
  }
  connectGlobalSocket() {
    const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
    const url = `${baseUrl}/ws?client_id=${encodeURIComponent(this.activeClientId)}&t=${Date.now()}`;
    try {
      if (this.globalSocket) {
        this.globalSocket.close();
      }
      this.globalSocket = new WebSocket(url);
      this.globalSocket.onopen = async () => {
        var _a, _b;
        console.log("CyberSync: \u{1F30D}\u2705 Connected!");
        this.isOnline = true;
        this.updateStatusBar("connected");
        (_a = this.globalSocket) == null ? void 0 : _a.send(
          JSON.stringify({
            type: "request_full_state",
            clientId: this.activeClientId,
            fileVersions: this.settings.fileVersions
          })
        );
        for (const [filePath, wasChanged] of Object.entries(
          this.settings.offlineChanges
        )) {
          if (wasChanged) {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof import_obsidian.TFile) {
              const content = await this.app.vault.read(file);
              (_b = this.globalSocket) == null ? void 0 : _b.send(
                JSON.stringify({
                  type: "sync_offline_changes",
                  filePath,
                  clientId: this.activeClientId,
                  content,
                  localVersion: this.settings.fileVersions[filePath] || 0
                })
              );
            }
          }
        }
      };
      this.globalSocket.onmessage = async (event) => {
        var _a, _b;
        const msg = JSON.parse(event.data);
        if (msg.clientId === this.activeClientId && !["ack", "conflict", "full_state"].includes(msg.type)) {
          return;
        }
        console.log("CyberSync: Received:", msg.type, msg.filePath);
        if (msg.type === "full_state") {
          this.settings.fileVersions = msg.fileVersions || {};
          this.settings.lastSyncedHash = msg.lastSyncedHashes || {};
          await this.saveSettings();
        } else if (msg.type === "text_change") {
          await this.applyTextChange(msg);
        } else if (msg.type === "file_created") {
          this.isApplyingRemoteAction = true;
          try {
            if (!this.app.vault.getAbstractFileByPath(msg.filePath)) {
              await this.createFolderRecursively(msg.filePath);
              await this.app.vault.create(msg.filePath, "");
              console.log("CyberSync: Remote Created ->", msg.filePath);
              this.settings.fileVersions[msg.filePath] = msg.version || 0;
              this.settings.lastSyncedHash[msg.filePath] = this.hashString("");
              await this.saveSettings();
            }
          } finally {
            this.isApplyingRemoteAction = false;
          }
        } else if (msg.type === "file_deleted") {
          this.isApplyingRemoteAction = true;
          try {
            const file = this.app.vault.getAbstractFileByPath(msg.filePath);
            if (file) {
              await this.app.vault.delete(file);
              console.log("CyberSync: Remote Deleted ->", msg.filePath);
            }
          } finally {
            this.isApplyingRemoteAction = false;
          }
        } else if (msg.type === "file_renamed") {
          this.isApplyingRemoteAction = true;
          try {
            const file = this.app.vault.getAbstractFileByPath(msg.oldPath);
            if (file) {
              await this.createFolderRecursively(msg.filePath);
              await this.app.vault.rename(file, msg.filePath);
              console.log(
                "CyberSync: Remote Renamed ->",
                msg.oldPath,
                "to",
                msg.filePath
              );
              this.settings.fileVersions[msg.filePath] = this.settings.fileVersions[msg.oldPath] || 0;
              this.settings.lastSyncedHash[msg.filePath] = this.settings.lastSyncedHash[msg.oldPath] || "";
              delete this.settings.fileVersions[msg.oldPath];
              delete this.settings.lastSyncedHash[msg.oldPath];
              await this.saveSettings();
            }
          } finally {
            this.isApplyingRemoteAction = false;
          }
        } else if (msg.type === "cursor") {
          const file = this.app.workspace.getActiveFile();
          if (file && file.path === msg.filePath) {
            const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
            const cm = (_a = view == null ? void 0 : view.editor) == null ? void 0 : _a.cm;
            if (cm) {
              cm.dispatch({
                effects: updateCursorEffect.of({
                  pos: msg.pos,
                  clientId: msg.clientId,
                  color: msg.color,
                  filePath: msg.filePath
                })
              });
            }
          }
        } else if (msg.type === "disconnect") {
          const file = this.app.workspace.getActiveFile();
          if (file && file.path === msg.filePath) {
            const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
            const cm = (_b = view == null ? void 0 : view.editor) == null ? void 0 : _b.cm;
            if (cm) {
              cm.dispatch({
                effects: removeCursorEffect.of(msg.clientId)
              });
            }
          }
        } else if (msg.type === "conflict") {
          this.showMergeConflict(msg);
        }
      };
      this.globalSocket.onclose = () => {
        console.log("CyberSync: \u{1F30D} Socket Closed");
        this.isOnline = false;
        this.updateStatusBar("disconnected");
        if (this.reconnectTimeout) {
          window.clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = window.setTimeout(() => {
          console.log("CyberSync: Attempting to reconnect...");
          this.connectGlobalSocket();
        }, 3e3);
      };
      this.globalSocket.onerror = (e) => {
        console.error("CyberSync: Socket Error", e);
      };
    } catch (e) {
      console.error("CyberSync: Connection Error", e);
    }
  }
  async applyTextChange(msg) {
    var _a;
    const file = this.app.workspace.getActiveFile();
    if (!file || file.path !== msg.filePath) return;
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view) return;
    const cm = view.editor.cm;
    if (!cm) return;
    try {
      const changeSet = import_state.ChangeSet.fromJSON(msg.changes);
      const docLength = cm.state.doc.length;
      if (changeSet.length !== docLength) {
        console.warn(`CyberSync: Document mismatch. Requesting full state.`);
        (_a = this.globalSocket) == null ? void 0 : _a.send(
          JSON.stringify({
            type: "request_full_state",
            clientId: this.activeClientId,
            fileVersions: this.settings.fileVersions
          })
        );
        return;
      }
      this.isApplyingRemoteAction = true;
      cm.dispatch({
        changes: changeSet,
        annotations: [RemoteUpdate.of(true)]
      });
      this.settings.fileVersions[msg.filePath] = msg.version;
      const newContent = cm.state.doc.toString();
      this.settings.lastSyncedHash[msg.filePath] = this.hashString(newContent);
      await this.saveSettings();
    } catch (e) {
      console.error("CyberSync: Failed to apply change", e);
    } finally {
      this.isApplyingRemoteAction = false;
    }
  }
  async showMergeConflict(msg) {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.path !== msg.filePath) return;
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view) return;
    const merged = `<<<<<<< LOCAL (Your changes)
${msg.localDiff}
=======
${msg.serverDiff}
>>>>>>> SERVER (Latest)`;
    view.editor.setValue(merged);
    new import_obsidian.Notice(
      "\u26A0\uFE0F CyberSync: Merge conflict! Resolve manually and save.",
      1e4
    );
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
    new import_obsidian.Setting(containerEl).setName("Server URL").setDesc("WebSocket server address").addText(
      (text) => text.setPlaceholder("ws://localhost:8000").setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
        this.plugin.settings.serverUrl = value;
        await this.plugin.saveSettings();
        this.plugin.forceReconnect();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Client ID").setDesc("Unique ID for this device").addText(
      (text) => text.setPlaceholder("client-123").setValue(this.plugin.settings.clientId).onChange(async (value) => {
        this.plugin.settings.clientId = value;
        await this.plugin.saveSettings();
        this.plugin.updateActiveClientId();
        this.plugin.forceReconnect();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Reset Cache").setDesc("Clear all sync data").addButton(
      (btn) => btn.setButtonText("Reset").setWarning().onClick(async () => {
        this.plugin.settings.fileVersions = {};
        this.plugin.settings.lastSyncedHash = {};
        this.plugin.settings.offlineChanges = {};
        await this.plugin.saveSettings();
        new import_obsidian.Notice("CyberSync: Cache cleared!");
        await this.plugin.forceReconnect();
      })
    );
  }
};
