import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
  TFile,
  Notice,
  TAbstractFile,
} from "obsidian";
import {
  Extension,
  StateField,
  StateEffect,
  ChangeSet,
  Transaction,
  Annotation,
  EditorState,
} from "@codemirror/state";
import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { toBase64, fromBase64 } from "lib0/buffer";

// --- SETTINGS ---
interface CyberSyncSettings {
  serverUrl: string;
  clientId: string;
  fileVersions: Record<string, number>;
  lastSyncedHash: Record<string, string>;
  offlineChanges: Record<string, boolean>; // Делали ли изменения оффлайн
}
const DEFAULT_SETTINGS: CyberSyncSettings = {
  serverUrl: "ws://localhost:8000",
  clientId: "",
  fileVersions: {},
  lastSyncedHash: {},
  offlineChanges: {},
};

const RemoteUpdate = Annotation.define<boolean>();

// --- КУРСОРЫ ---
interface CursorPosition {
  pos: number;
  clientId: string;
  color: string;
  filePath: string;
}
const cursorEffect = StateEffect.define<RemoteCursor[]>();
class CursorWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly label: string,
  ) {
    super();
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
}
const cursorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(cursors, tr) {
    try {
      try {
        cursors = cursors.map(tr.changes);
      } catch (e) {
        return Decoration.none;
      }

      for (let e of tr.effects) {
        if (e.is(updateCursorEffect)) {
          if (e.value.pos < 0 || e.value.pos > tr.newDoc.length) continue;
          const deco = Decoration.widget({
            widget: new CursorWidget(e.value.color, e.value.clientId),
            side: 0,
          }).range(e.value.pos);
          cursors = cursors.update({
            filter: (from, to, value) =>
              (value.widget as any).label !== e.value.clientId,
            add: [deco],
          });
        }
        if (e.is(removeCursorEffect)) {
          cursors = cursors.update({
            filter: (from, to, value) =>
              (value.widget as any).label !== e.value,
          });
        }
      }
      return cursors;
    } catch (e) {
      return Decoration.none;
    }
  },
  provide: (f) => EditorView.decorations.from(f),
});

export default class SyncPlugin extends Plugin {
  settings: CyberSyncSettings;
  globalSocket: WebSocket | null = null;
  private reconnectTimeout: number | null = null;

  activeClientId: string;
  color: string = "#" + Math.floor(Math.random() * 16777215).toString(16);
  statusBarItem: HTMLElement;

  private isOnline = false;
  private isApplyingRemoteAction = false;
  private pendingLocalChanges: Map<string, { changes: any; hash: string }> =
    new Map();

  private hashString(str: string): string {
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
      }, 5000),
    );

    this.updateStatusBar("disconnected");
    this.addSettingTab(new CyberSyncSettingTab(this.app, this));

    this.connectGlobalSocket();

    // === VAULT EVENTS ===
    this.registerEvent(
      this.app.vault.on("create", (file) => this.onLocalFileCreate(file)),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.onLocalFileDelete(file)),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) =>
        this.onLocalFileRename(file, oldPath),
      ),
    );

    // === EDITOR SYNC ===
    const pluginInstance = this;
    const syncExtension = EditorView.updateListener.of((update: ViewUpdate) => {
      if (!pluginInstance.isOnline) {
        // ОФФЛАЙН: Записываем что делали изменения
        const file = pluginInstance.app.workspace.getActiveFile();
        if (file && update.docChanged) {
          pluginInstance.settings.offlineChanges[file.path] = true;
          pluginInstance.saveSettings();
        }
        return;
      }

      if (pluginInstance.globalSocket?.readyState !== WebSocket.OPEN) return;
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
            version: pluginInstance.settings.fileVersions[file.path] || 0,
          }),
        );

        pluginInstance.settings.lastSyncedHash[file.path] =
          pluginInstance.hashString(newContent);
      }

      if (update.selectionSet) {
        const pos = update.state.selection.main.head;
        pluginInstance.globalSocket.send(
          JSON.stringify({
            type: "cursor",
            filePath: file.path,
            pos: pos,
            color: pluginInstance.color,
            clientId: pluginInstance.activeClientId,
          }),
        );
      }
    });

    this.registerEditorExtension([cursorField, syncExtension]);

    this.app.workspace.on("file-open", (file) => {
      if (file) {
        // При открытии файла проверяем оффлайн изменения
        const wasChangedOffline = this.settings.offlineChanges[file.path];
        if (wasChangedOffline && this.isOnline) {
          this.globalSocket?.send(
            JSON.stringify({
              type: "sync_offline_changes",
              filePath: file.path,
              clientId: this.activeClientId,
            }),
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
    new Notice("CyberSync: Reconnecting...");
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

  updateStatusBar(forceStatus?: string) {
    this.statusBarItem.empty();
    const icon = this.statusBarItem.createSpan({
      cls: "cybersync-status-icon",
    });

    let text = "";
    let color = "";

    if (forceStatus === "connected") {
      text = "● CyberSync: OK";
      color = "var(--text-success)";
    } else if (forceStatus === "disconnected") {
      text = "× CyberSync: Off";
      color = "var(--text-muted)";
    } else if (this.isOnline) {
      text = "● CyberSync: OK";
      color = "var(--text-success)";
    } else {
      text = "⚠️ CyberSync: Offline";
      color = "var(--text-warning)";
    }

    icon.setText(text);
    icon.style.color = color;
  }

  onLocalFileCreate(file: TAbstractFile) {
    if (this.isApplyingRemoteAction) return;
    if (!(file instanceof TFile)) return;

    console.log("CyberSync: Local Create ->", file.path);

    if (this.isOnline) {
      this.globalSocket?.send(
        JSON.stringify({
          type: "file_created",
          filePath: file.path,
          clientId: this.activeClientId,
        }),
      );
    } else {
      this.settings.offlineChanges[file.path] = true;
      this.saveSettings();
    }
  }

  onLocalFileDelete(file: TAbstractFile) {
    if (this.isApplyingRemoteAction) return;
    if (!(file instanceof TFile)) return;

    console.log("CyberSync: Local Delete ->", file.path);

    if (this.isOnline) {
      this.globalSocket?.send(
        JSON.stringify({
          type: "file_deleted",
          filePath: file.path,
          clientId: this.activeClientId,
        }),
      );
    }
  }

  onLocalFileRename(file: TAbstractFile, oldPath: string) {
    if (this.isApplyingRemoteAction) return;
    if (!(file instanceof TFile)) return;

    console.log("CyberSync: Local Rename ->", oldPath, "to", file.path);

    if (this.isOnline) {
      this.globalSocket?.send(
        JSON.stringify({
          type: "file_renamed",
          filePath: file.path,
          oldPath: oldPath,
          clientId: this.activeClientId,
        }),
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
        console.log("CyberSync: 🌍✅ Connected!");
        this.isOnline = true;
        this.updateStatusBar("connected");

        // Запрашиваем полное состояние хранилища
        this.globalSocket?.send(
          JSON.stringify({
            type: "request_full_state",
            clientId: this.activeClientId,
            fileVersions: this.settings.fileVersions,
          }),
        );

        // Отправляем оффлайн изменения
        for (const [filePath, wasChanged] of Object.entries(
          this.settings.offlineChanges,
        )) {
          if (wasChanged) {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
              const content = await this.app.vault.read(file);
              this.globalSocket?.send(
                JSON.stringify({
                  type: "sync_offline_changes",
                  filePath: filePath,
                  clientId: this.activeClientId,
                  content: content,
                  localVersion: this.settings.fileVersions[filePath] || 0,
                }),
              );
            }
          }
        }
      };

      this.globalSocket.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        // Игнорируем свои сообщения (кроме ack и других системных)
        if (
          msg.clientId === this.activeClientId &&
          !["ack", "conflict", "full_state"].includes(msg.type)
        ) {
          return;
        }

        console.log("CyberSync: Received:", msg.type, msg.filePath);

        if (msg.type === "full_state") {
          // Получили полное состояние при подключении
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
                msg.filePath,
              );
              this.settings.fileVersions[msg.filePath] =
                this.settings.fileVersions[msg.oldPath] || 0;
              this.settings.lastSyncedHash[msg.filePath] =
                this.settings.lastSyncedHash[msg.oldPath] || "";
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
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            // @ts-ignore
            const cm = view?.editor?.cm as EditorView;
            if (cm) {
              cm.dispatch({
                effects: updateCursorEffect.of({
                  pos: msg.pos,
                  clientId: msg.clientId,
                  color: msg.color,
                  filePath: msg.filePath,
                }),
              });
            }
          }
        } else if (msg.type === "disconnect") {
          const file = this.app.workspace.getActiveFile();
          if (file && file.path === msg.filePath) {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            // @ts-ignore
            const cm = view?.editor?.cm as EditorView;
            if (cm) {
              cm.dispatch({
                effects: removeCursorEffect.of(msg.clientId),
              });
            }
          }
        } else if (msg.type === "conflict") {
          // Конфликт: показываем обе версии
          this.showMergeConflict(msg);
        }
      };

      this.globalSocket.onclose = () => {
        console.log("CyberSync: 🌍 Socket Closed");
        this.isOnline = false;
        this.updateStatusBar("disconnected");

        if (this.reconnectTimeout) {
          window.clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = window.setTimeout(() => {
          console.log("CyberSync: Attempting to reconnect...");
          this.connectGlobalSocket();
        }, 3000);
      };

      this.globalSocket.onerror = (e) => {
        console.error("CyberSync: Socket Error", e);
      };
    } catch (e) {
      console.error("CyberSync: Connection Error", e);
    }
  }

  private async applyTextChange(msg: any) {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.path !== msg.filePath) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    // @ts-ignore
    const cm = view.editor.cm as EditorView;
    if (!cm) return;

    try {
      const changeSet = ChangeSet.fromJSON(msg.changes);

      const docLength = cm.state.doc.length;
      if (changeSet.length !== docLength) {
        console.warn(`CyberSync: Document mismatch. Requesting full state.`);
        this.globalSocket?.send(
          JSON.stringify({
            type: "request_full_state",
            clientId: this.activeClientId,
            fileVersions: this.settings.fileVersions,
          }),
        );
        return;
      }

      this.isApplyingRemoteAction = true;
      cm.dispatch({
        changes: changeSet,
        annotations: [RemoteUpdate.of(true)],
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

  private async showMergeConflict(msg: any) {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.path !== msg.filePath) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    // Показываем diff в формате Git-like конфликтов, но по строкам
    const merged = `<<<<<<< LOCAL (Your changes)
${msg.localDiff}
=======
${msg.serverDiff}
>>>>>>> SERVER (Latest)`;

    view.editor.setValue(merged);
    new Notice(
      "⚠️ CyberSync: Merge conflict! Resolve manually and save.",
      10000,
    );
  }

  async createFolderRecursively(path: string) {
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
      this.settings.clientId =
        "client-" + Math.random().toString(36).substr(2, 9);
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
}

class CyberSyncSettingTab extends PluginSettingTab {
  plugin: SyncPlugin;

  constructor(app: App, plugin: SyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "CyberSync Settings" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("WebSocket server address")
      .addText((text) =>
        text
          .setPlaceholder("ws://localhost:8000")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
            this.plugin.forceReconnect();
          }),
      );

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("Unique ID for this device")
      .addText((text) =>
        text
          .setPlaceholder("client-123")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value;
            await this.plugin.saveSettings();
            this.plugin.updateActiveClientId();
            this.plugin.forceReconnect();
          }),
      );

    new Setting(containerEl)
      .setName("Reset Cache")
      .setDesc("Clear all sync data")
      .addButton((btn) =>
        btn
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.fileVersions = {};
            this.plugin.settings.lastSyncedHash = {};
            this.plugin.settings.offlineChanges = {};
            await this.plugin.saveSettings();
            new Notice("CyberSync: Cache cleared!");
            await this.plugin.forceReconnect();
          }),
      );
  }
}
