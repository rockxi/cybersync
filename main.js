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
  clientId: ""
};
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
    cursors = cursors.map(tr.changes);
    for (let e of tr.effects) {
      if (e.is(updateCursorEffect)) {
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
    __publicField(this, "isApplyingRemoteChange", false);
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
        if (update.docChanged && !this.isApplyingRemoteChange) {
          pluginInstance.socket.send(
            JSON.stringify({
              type: "text_change",
              changes: update.changes.toJSON(),
              clientId: pluginInstance.activeClientId
            })
          );
        }
        if (update.selectionSet) {
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
    );
    this.registerEditorExtension([cursorField, syncExtension]);
    this.app.workspace.on("file-open", (file) => {
      if (file) this.connectSocket(file.path);
    });
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) this.connectSocket(activeFile.path);
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
    switch (status) {
      case "connected":
        icon.setText("\u25CF CyberSync: OK");
        icon.style.color = "var(--text-success)";
        break;
      case "connecting":
        icon.setText("\u25CB CyberSync: ...");
        icon.style.color = "var(--text-accent)";
        break;
      case "error":
        icon.setText("\xD7 CyberSync: Err");
        icon.style.color = "var(--text-error)";
        break;
      case "disconnected":
        icon.setText("\u25CF CyberSync: Off");
        icon.style.color = "var(--text-muted)";
        break;
    }
  }
  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.updateActiveClientId();
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) this.connectSocket(activeFile.path);
  }
  connectSocket(fileId) {
    if (this.socket) {
      this.socket.close();
    }
    this.updateStatusBar("connecting");
    const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
    const url = `${baseUrl}/ws/${encodeURIComponent(fileId)}/${encodeURIComponent(this.activeClientId)}`;
    try {
      this.socket = new WebSocket(url);
      this.socket.onopen = () => {
        console.log("CyberSync connected");
        this.updateStatusBar("connected");
      };
      this.socket.onclose = () => {
        this.updateStatusBar("disconnected");
      };
      this.socket.onerror = () => {
        this.updateStatusBar("error");
      };
      this.socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
        if (!view || data.clientId === this.activeClientId) return;
        const cm = view.editor.cm;
        if (data.type === "text_change") {
          this.isApplyingRemoteChange = true;
          try {
            cm.dispatch({
              changes: import_state.ChangeSet.fromJSON(data.changes)
            });
          } catch (e) {
            console.error("Failed to apply remote change", e);
          } finally {
            this.isApplyingRemoteChange = false;
          }
        } else if (data.type === "cursor") {
          cm.dispatch({
            effects: updateCursorEffect.of({
              pos: data.pos,
              clientId: data.clientId,
              color: data.color
            })
          });
        } else if (data.type === "disconnect") {
          cm.dispatch({
            effects: removeCursorEffect.of(data.clientId)
          });
        }
      };
    } catch (e) {
      this.updateStatusBar("error");
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
    new import_obsidian.Setting(containerEl).setName("Client ID").setDesc("Nickname for sync").addText(
      (text) => text.setValue(this.plugin.settings.clientId).onChange(async (v) => {
        this.plugin.settings.clientId = v;
        await this.plugin.saveSettings();
      })
    );
  }
};
