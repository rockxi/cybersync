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
  // По умолчанию пусто, будет генерироваться случайно
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
          filter: (from, to, value) => {
            return value.widget.label !== e.value.clientId;
          },
          add: [deco]
        });
      }
      if (e.is(removeCursorEffect)) {
        cursors = cursors.update({
          filter: (from, to, value) => {
            return value.widget.label !== e.value;
          }
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
    // ID, который используется в текущей сессии
    __publicField(this, "color", "#" + Math.floor(Math.random() * 16777215).toString(16));
  }
  async onload() {
    await this.loadSettings();
    this.updateActiveClientId();
    this.addSettingTab(new CyberSyncSettingTab(this.app, this));
    const pluginInstance = this;
    const socketListener = import_view.ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.view = view;
        }
        update(update) {
          var _a;
          if (update.selectionSet && ((_a = pluginInstance.socket) == null ? void 0 : _a.readyState) === WebSocket.OPEN) {
            const pos = update.state.selection.main.head;
            pluginInstance.socket.send(
              JSON.stringify({
                type: "cursor",
                pos,
                color: pluginInstance.color
              })
            );
          }
        }
      }
    );
    this.registerEditorExtension([cursorField, socketListener]);
    this.app.workspace.on("file-open", (file) => {
      if (file) this.connectSocket(file.path);
    });
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      this.connectSocket(activeFile.path);
    }
  }
  updateActiveClientId() {
    if (this.settings.clientId && this.settings.clientId.trim() !== "") {
      this.activeClientId = this.settings.clientId.trim();
    } else {
      this.activeClientId = "User_" + Math.floor(Math.random() * 1e3);
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
    if (activeFile) {
      this.connectSocket(activeFile.path);
    }
  }
  connectSocket(fileId) {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
    const encodedId = encodeURIComponent(fileId);
    const url = `${baseUrl}/ws/${encodedId}/${encodeURIComponent(this.activeClientId)}`;
    console.log("Connecting to:", url, "as", this.activeClientId);
    try {
      this.socket = new WebSocket(url);
      this.socket.onopen = () => console.log("CyberSync connected");
      this.socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
        if (!view) return;
        if (data.clientId === this.activeClientId) return;
        if (data.type === "cursor") {
          view.editor.cm.dispatch({
            effects: updateCursorEffect.of({
              pos: data.pos,
              clientId: data.clientId,
              color: data.color
            })
          });
        } else if (data.type === "disconnect") {
          view.editor.cm.dispatch({
            effects: removeCursorEffect.of(data.clientId)
          });
        }
      };
    } catch (e) {
      console.error("Connection error:", e);
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
    new import_obsidian.Setting(containerEl).setName("Server URL").setDesc("WebSocket server address").addText(
      (text) => text.setPlaceholder("ws://localhost:8000").setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
        this.plugin.settings.serverUrl = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Client ID").setDesc(
      "Your nickname shown to others. Leave empty for random ID."
    ).addText(
      (text) => text.setPlaceholder("Enter your name").setValue(this.plugin.settings.clientId).onChange(async (value) => {
        this.plugin.settings.clientId = value;
        await this.plugin.saveSettings();
      })
    );
  }
};
