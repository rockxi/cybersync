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
          if (e.value.pos < 0 || e.value.pos > tr.newDoc.length)
            continue;
          const deco = import_view.Decoration.widget({
            widget: new CursorWidget(
              e.value.color,
              e.value.clientId
            ),
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
    __publicField(this, "fileSocket", null);
    __publicField(this, "vaultSocket", null);
    // Очередь для сообщений Vault (если сокет не готов)
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
    this.updateStatusBar("disconnected");
    this.addSettingTab(new CyberSyncSettingTab(this.app, this));
    this.connectVaultSocket();
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
    const syncExtension = import_view.EditorView.updateListener.of(
      (update) => {
        var _a;
        if (((_a = pluginInstance.fileSocket) == null ? void 0 : _a.readyState) !== WebSocket.OPEN)
          return;
        if (update.transactions.some(
          (tr) => tr.annotation(RemoteUpdate)
        ))
          return;
        if (update.docChanged) {
          pluginInstance.lastLocalChangeTime = Date.now();
          pluginInstance.fileSocket.send(
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
            pluginInstance.fileSocket.send(
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
      if (file) this.connectFileSocket(file.path);
      else if (this.fileSocket) {
        this.fileSocket.close();
        this.fileSocket = null;
      }
    });
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) this.connectFileSocket(activeFile.path);
  }
  // --- VAULT EVENTS ---
  sendVaultMessage(msg) {
    const json = JSON.stringify(msg);
    if (this.vaultSocket && this.vaultSocket.readyState === WebSocket.OPEN) {
      this.vaultSocket.send(json);
    } else {
      console.log(
        "CyberSync: Vault socket not ready, queuing message:",
        msg.type
      );
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
    console.log(
      "CyberSync: Local Rename Detected ->",
      oldPath,
      "to",
      file.path
    );
    this.sendVaultMessage({
      type: "file_renamed",
      path: file.path,
      oldPath
    });
  }
  // --- VAULT SOCKET CONNECTION ---
  connectVaultSocket() {
    const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
    const url = `${baseUrl}/ws?file_id=__global__&client_id=${encodeURIComponent(this.activeClientId)}`;
    console.log("CyberSync: Connecting to Vault Socket...", url);
    try {
      if (this.vaultSocket) {
        this.vaultSocket.close();
      }
      this.vaultSocket = new WebSocket(url);
      this.vaultSocket.onopen = () => {
        var _a;
        console.log("CyberSync: \u2705 Connected to Global Vault!");
        while (this.vaultMessageQueue.length > 0) {
          const msg = this.vaultMessageQueue.shift();
          if (msg) (_a = this.vaultSocket) == null ? void 0 : _a.send(msg);
        }
      };
      this.vaultSocket.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        if (data.clientId === this.activeClientId) return;
        console.log(
          "CyberSync: Received Vault Event:",
          data.type,
          data.path
        );
        this.isApplyingRemoteVaultAction = true;
        try {
          if (data.type === "vault_sync_init") {
            const serverFiles = data.files || [];
            console.log(
              "CyberSync: Initial Sync. Files:",
              serverFiles.length
            );
            for (const path of serverFiles) {
              if (!this.app.vault.getAbstractFileByPath(path)) {
                try {
                  await this.createFolderRecursively(path);
                  await this.app.vault.create(path, "");
                  console.log(
                    "CyberSync: Synced missing file:",
                    path
                  );
                } catch (e) {
                  console.warn(
                    "Failed to sync file:",
                    path,
                    e
                  );
                }
              }
            }
          } else if (data.type === "file_created") {
            if (!this.app.vault.getAbstractFileByPath(data.path)) {
              await this.createFolderRecursively(data.path);
              await this.app.vault.create(data.path, "");
              new import_obsidian.Notice(`Remote created: ${data.path}`);
            }
          } else if (data.type === "file_deleted") {
            const file = this.app.vault.getAbstractFileByPath(
              data.path
            );
            if (file) {
              await this.app.vault.delete(file);
              new import_obsidian.Notice(`Remote deleted: ${data.path}`);
            }
          } else if (data.type === "file_renamed") {
            const file = this.app.vault.getAbstractFileByPath(
              data.oldPath
            );
            if (file) {
              await this.createFolderRecursively(data.path);
              await this.app.vault.rename(file, data.path);
              new import_obsidian.Notice(
                `Remote renamed: ${data.oldPath} -> ${data.path}`
              );
            }
          }
        } catch (e) {
          console.error("Vault Sync Error:", e);
        } finally {
          this.isApplyingRemoteVaultAction = false;
        }
      };
      this.vaultSocket.onclose = () => {
        console.warn("CyberSync: Vault Socket closed. Retry in 5s...");
        setTimeout(() => this.connectVaultSocket(), 5e3);
      };
      this.vaultSocket.onerror = (e) => {
        console.error("CyberSync: Vault Socket Error", e);
      };
    } catch (e) {
      console.error("CyberSync: Failed to connect Vault Socket", e);
    }
  }
  async createFolderRecursively(path) {
    const folders = path.split("/").slice(0, -1);
    if (folders.length === 0) return;
    let currentPath = "";
    for (const folder of folders) {
      currentPath = currentPath === "" ? folder : `${currentPath}/${folder}`;
      if (!this.app.vault.getAbstractFileByPath(currentPath)) {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }
  // --- TEXT SYNC HELPERS ---
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
    let text = "\u25CF CyberSync: Off";
    let color = "var(--text-muted)";
    if (status === "connected") {
      text = "\u25CF CyberSync: OK";
      color = "var(--text-success)";
    } else if (status === "syncing") {
      text = "\u21BB CyberSync: Sync";
      color = "var(--text-warning)";
    } else if (status === "error") {
      text = "\xD7 CyberSync: Err";
      color = "var(--text-error)";
    }
    icon.setText(text);
    icon.style.color = color;
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
  normalizeText(text) {
    return text.replace(/\r\n/g, "\n");
  }
  connectFileSocket(fileId) {
    if (this.fileSocket) {
      this.fileSocket.close();
      this.fileSocket = null;
    }
    this.isRequestingFullSync = false;
    this.updateStatusBar("connecting");
    const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
    const url = `${baseUrl}/ws?file_id=${encodeURIComponent(fileId)}&client_id=${encodeURIComponent(this.activeClientId)}`;
    try {
      this.fileSocket = new WebSocket(url);
      this.fileSocket.onopen = () => {
        var _a;
        console.log(`CyberSync: File Connected ${fileId}`);
        this.updateStatusBar("connected");
        const currentVer = this.getLocalVersion(fileId) || 0;
        (_a = this.fileSocket) == null ? void 0 : _a.send(
          JSON.stringify({
            type: "handshake",
            version: Number(currentVer)
          })
        );
      };
      this.fileSocket.onclose = () => {
        this.updateStatusBar("disconnected");
        this.isRequestingFullSync = false;
      };
      this.fileSocket.onerror = () => {
        this.updateStatusBar("error");
        this.isRequestingFullSync = false;
      };
      this.fileSocket.onmessage = async (event) => {
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
            this.requestFullSync(file.path);
          } finally {
            if (!data.is_history) this.updateStatusBar("connected");
          }
        } else if (data.type === "ack") {
          const ver = Number(data.version || 0);
          if (ver) {
            await this.updateLocalVersion(file.path, ver);
            const content = this.normalizeText(
              cm.state.doc.toString()
            );
            (_a = this.fileSocket) == null ? void 0 : _a.send(
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
            const serverContent = this.normalizeText(
              data.content || ""
            );
            const localContent = this.normalizeText(
              cm.state.doc.toString()
            );
            const serverVer = Number(data.version || 0);
            const normalize = (str) => str.replace(/\s+$/, "");
            if (serverContent === localContent) {
              await this.updateLocalVersion(file.path, serverVer);
            } else if (normalize(serverContent) === normalize(localContent)) {
              cm.dispatch({
                changes: {
                  from: 0,
                  to: cm.state.doc.length,
                  insert: serverContent
                },
                scrollIntoView: false,
                annotations: [RemoteUpdate.of(true)]
              });
              await this.updateLocalVersion(file.path, serverVer);
            } else {
              const timeSinceEdit = Date.now() - this.lastLocalChangeTime;
              const isUserIdle = timeSinceEdit > 3e3;
              const serverHasMarkers = this.hasConflictMarkers(serverContent);
              const localHasMarkers = this.hasConflictMarkers(localContent);
              if (isUserIdle || !serverHasMarkers && localHasMarkers) {
                cm.dispatch({
                  changes: {
                    from: 0,
                    to: cm.state.doc.length,
                    insert: serverContent
                  },
                  scrollIntoView: false,
                  annotations: [RemoteUpdate.of(true)]
                });
                await this.updateLocalVersion(
                  file.path,
                  serverVer
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
                    to: cm.state.doc.length,
                    insert: conflictText
                  },
                  scrollIntoView: false,
                  annotations: [RemoteUpdate.of(true)]
                });
                await this.updateLocalVersion(
                  file.path,
                  serverVer
                );
                new import_obsidian.Notice("CyberSync: Conflict detected.");
              }
            }
          } catch (e) {
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
  requestFullSync(fileId) {
    if (this.isRequestingFullSync) return;
    if (!this.fileSocket || this.fileSocket.readyState !== WebSocket.OPEN)
      return;
    this.isRequestingFullSync = true;
    this.updateStatusBar("syncing");
    this.fileSocket.send(JSON.stringify({ type: "full_sync" }));
    setTimeout(() => {
      if (this.isRequestingFullSync) {
        this.isRequestingFullSync = false;
        this.updateStatusBar("connected");
      }
    }, 5e3);
  }
  onunload() {
    if (this.fileSocket) this.fileSocket.close();
    if (this.vaultSocket) this.vaultSocket.close();
  }
};
var CyberSyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    __publicField(this, "plugin");
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
    new import_obsidian.Setting(containerEl).setName("Reset Local Versions").setDesc("Dangerous").addButton(
      (btn) => btn.setButtonText("Reset Cache").setWarning().onClick(async () => {
        this.plugin.settings.fileVersions = {};
        await this.plugin.saveSettings();
        new import_obsidian.Notice("Local version cache cleared");
      })
    );
  }
};
