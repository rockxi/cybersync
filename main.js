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
      cursors = cursors.map(tr.changes);
    } catch (e) {
      return import_view.Decoration.none;
    }
    for (let e of tr.effects) {
      if (e.is(updateCursorEffect)) {
        if (e.value.pos > tr.newDoc.length) continue;
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
  },
  provide: (f) => import_view.EditorView.decorations.from(f)
});
var SyncPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    __publicField(this, "settings");
    __publicField(this, "socket", null);
    __publicField(this, "activeClientId");
    __publicField(this, "color", "#" + Math.floor(Math.random() * 16777215).toString(16));
    __publicField(this, "statusBarItem");
    __publicField(this, "isRequestingFullSync", false);
  }
  async onload() {
    await this.loadSettings();
    this.updateActiveClientId();
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar("disconnected");
    this.addSettingTab(new CyberSyncSettingTab(this.app, this));
    const pluginInstance = this;
    const syncExtension = import_view.EditorView.updateListener.of(
      (update) => {
        var _a;
        if (((_a = pluginInstance.socket) == null ? void 0 : _a.readyState) !== WebSocket.OPEN)
          return;
        if (update.transactions.some(
          (tr) => tr.annotation(RemoteUpdate)
        )) {
          return;
        }
        if (update.docChanged) {
          pluginInstance.socket.send(
            JSON.stringify({
              type: "text_change",
              changes: update.changes.toJSON(),
              clientId: pluginInstance.activeClientId
            })
          );
        }
        if (update.selectionSet) {
          if (!update.transactions.some(
            (tr) => tr.annotation(RemoteUpdate)
          )) {
            const pos = update.state.selection.main.head;
            pluginInstance.socket.send(
              JSON.stringify({
                type: "cursor",
                pos,
                color: pluginInstance.color,
                clientId: pluginInstance.activeClientId
              })
            );
          }
        }
      }
    );
    this.registerEditorExtension([cursorField, syncExtension]);
    this.app.workspace.on("file-open", (file) => {
      if (file) this.connectSocket(file.path);
    });
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) this.connectSocket(activeFile.path);
  }
  async updateLocalVersion(filePath, version) {
    this.settings.fileVersions[filePath] = version;
    await this.saveSettings();
  }
  getLocalVersion(filePath) {
    return this.settings.fileVersions[filePath] || 0;
  }
  updateActiveClientId() {
    var _a;
    this.activeClientId = ((_a = this.settings.clientId) == null ? void 0 : _a.trim()) || "User_" + Math.floor(Math.random() * 1e3);
  }
  updateStatusBar(status) {
    this.statusBarItem.empty();
    const icon = this.statusBarItem.createSpan({
      cls: "cybersync-status-icon"
    });
    if (status === "connected") {
      icon.setText("\u25CF CyberSync: OK");
      icon.style.color = "var(--text-success)";
    } else if (status === "syncing") {
      icon.setText("\u21BB CyberSync: Sync");
      icon.style.color = "var(--text-warning)";
    } else if (status === "error") {
      icon.setText("\xD7 CyberSync: Err");
      icon.style.color = "var(--text-error)";
    } else {
      icon.setText("\u25CF CyberSync: Off");
      icon.style.color = "var(--text-muted)";
    }
  }
  requestFullSync(fileId) {
    if (this.isRequestingFullSync) return;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    console.log("CyberSync: Requesting Full Sync...");
    this.isRequestingFullSync = true;
    this.updateStatusBar("syncing");
    this.socket.send(
      JSON.stringify({
        type: "full_sync"
      })
    );
    setTimeout(() => {
      if (this.isRequestingFullSync) {
        console.warn("CyberSync: Full sync timed out");
        this.isRequestingFullSync = false;
        this.updateStatusBar("connected");
      }
    }, 5e3);
  }
  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
    if (!this.settings.fileVersions) this.settings.fileVersions = {};
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  hasConflictMarkers(text) {
    return /^<<<<<<< REMOTE \(Server v\d+\)/m.test(text);
  }
  connectSocket(fileId) {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isRequestingFullSync = false;
    this.updateStatusBar("connecting");
    const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
    const url = `${baseUrl}/ws/${encodeURIComponent(fileId)}/${encodeURIComponent(this.activeClientId)}`;
    try {
      this.socket = new WebSocket(url);
      this.socket.onopen = () => {
        var _a;
        console.log(`CyberSync: Connected to ${fileId}`);
        this.updateStatusBar("connected");
        const currentVer = this.getLocalVersion(fileId) || 0;
        (_a = this.socket) == null ? void 0 : _a.send(
          JSON.stringify({
            type: "handshake",
            version: Number(currentVer)
          })
        );
      };
      this.socket.onclose = () => {
        this.updateStatusBar("disconnected");
        this.isRequestingFullSync = false;
      };
      this.socket.onerror = () => {
        this.updateStatusBar("error");
        this.isRequestingFullSync = false;
      };
      this.socket.onmessage = async (event) => {
        var _a;
        const data = JSON.parse(event.data);
        const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
        if (!view) return;
        const file = view.file;
        if (!file) return;
        const cm = view.editor.cm;
        if (data.type === "text_change") {
          if (this.isRequestingFullSync) return;
          const localVer = this.getLocalVersion(file.path);
          if (data.version && data.version <= localVer) return;
          if (data.clientId === this.activeClientId && !data.is_history)
            return;
          if (data.is_history) this.updateStatusBar("syncing");
          try {
            const changes = import_state.ChangeSet.fromJSON(data.changes);
            if (changes.length !== cm.state.doc.length) {
              console.warn(
                `CyberSync: Mismatch v${data.version}. Req Full Sync.`
              );
              this.requestFullSync(file.path);
              return;
            }
            cm.dispatch({
              changes,
              scrollIntoView: !data.is_history,
              annotations: [RemoteUpdate.of(true)]
            });
            if (data.version)
              await this.updateLocalVersion(
                file.path,
                data.version
              );
          } catch (e) {
            console.error("Apply delta failed", e);
            this.requestFullSync(file.path);
          } finally {
            if (!data.is_history) this.updateStatusBar("connected");
          }
        } else if (data.type === "ack") {
          const ver = Number(data.version || 0);
          if (ver) {
            await this.updateLocalVersion(file.path, ver);
            const content = cm.state.doc.toString();
            (_a = this.socket) == null ? void 0 : _a.send(
              JSON.stringify({
                type: "snapshot_hint",
                version: ver,
                content
              })
            );
          }
        } else if (data.type === "full_sync") {
          this.isRequestingFullSync = false;
          try {
            const serverContent = data.content || "";
            const localContent = cm.state.doc.toString();
            const serverVer = Number(data.version || 0);
            console.log(
              `CyberSync: Applying Full Sync v${serverVer}`
            );
            if (serverContent === localContent) {
              await this.updateLocalVersion(file.path, serverVer);
              console.log("CyberSync: Full sync matched.");
            } else {
              const serverHasMarkers = this.hasConflictMarkers(serverContent);
              const localHasMarkers = this.hasConflictMarkers(localContent);
              if (!serverHasMarkers && localHasMarkers) {
                console.log(
                  "CyberSync: Detected resolution from server. Overwriting local conflicts."
                );
                cm.dispatch({
                  changes: {
                    from: 0,
                    to: localContent.length,
                    insert: serverContent
                  },
                  scrollIntoView: false,
                  annotations: [RemoteUpdate.of(true)]
                });
                await this.updateLocalVersion(
                  file.path,
                  serverVer
                );
                new import_obsidian.Notice(
                  "CyberSync: Conflict resolved remotely."
                );
              } else {
                const conflictText = `<<<<<<< REMOTE (Server v${serverVer})
${serverContent}
=======
${localContent}
>>>>>>> LOCAL (My changes)
`;
                cm.dispatch({
                  changes: {
                    from: 0,
                    to: localContent.length,
                    insert: conflictText
                  },
                  scrollIntoView: false,
                  annotations: [RemoteUpdate.of(true)]
                });
                await this.updateLocalVersion(
                  file.path,
                  serverVer
                );
                new import_obsidian.Notice(
                  "CyberSync: Conflict detected. Resolve manually."
                );
              }
            }
          } catch (e) {
            console.error("Full sync failed", e);
          } finally {
            this.updateStatusBar("connected");
          }
        } else if (data.type === "cursor") {
          if (data.clientId === this.activeClientId) return;
          cm.dispatch({
            effects: updateCursorEffect.of({
              pos: data.pos,
              clientId: data.clientId,
              color: data.color
            }),
            annotations: [RemoteUpdate.of(true)]
          });
        } else if (data.type === "disconnect") {
          cm.dispatch({
            effects: removeCursorEffect.of(data.clientId),
            annotations: [RemoteUpdate.of(true)]
          });
        }
      };
    } catch (e) {
      this.updateStatusBar("error");
      this.isRequestingFullSync = false;
    }
  }
  onunload() {
    if (this.socket) this.socket.close();
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
    new import_obsidian.Setting(containerEl).setName("Server URL").addText(
      (text) => text.setValue(this.plugin.settings.serverUrl).onChange(async (v) => {
        this.plugin.settings.serverUrl = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Client ID").addText(
      (text) => text.setValue(this.plugin.settings.clientId).onChange(async (v) => {
        this.plugin.settings.clientId = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Reset Local Versions").setDesc("Dangerous: Will force re-download").addButton(
      (btn) => btn.setButtonText("Reset Cache").setWarning().onClick(async () => {
        this.plugin.settings.fileVersions = {};
        await this.plugin.saveSettings();
        new import_obsidian.Notice("Local version cache cleared");
      })
    );
  }
};
