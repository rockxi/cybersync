import {
    App,
    Plugin,
    PluginSettingTab,
    Setting,
    MarkdownView,
    TFile,
    Notice,
    TAbstractFile
} from "obsidian";
import {
    Extension,
    StateField,
    StateEffect,
    ChangeSet,
    Transaction,
    Annotation
} from "@codemirror/state";
import {
    EditorView,
    Decoration,
    DecorationSet,
    ViewPlugin,
    ViewUpdate,
    WidgetType,
} from "@codemirror/view";

// --- НАСТРОЙКИ ---
interface CyberSyncSettings {
    serverUrl: string;
    clientId: string;
    fileVersions: Record<string, number>;
}

const DEFAULT_SETTINGS: CyberSyncSettings = {
    serverUrl: "ws://localhost:8000",
    clientId: "",
    fileVersions: {},
};

const RemoteUpdate = Annotation.define<boolean>();

// --- КУРСОРЫ ---
interface CursorPosition {
    pos: number;
    clientId: string;
    color: string;
}

const updateCursorEffect = StateEffect.define<CursorPosition>();
const removeCursorEffect = StateEffect.define<string>();

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
            try { cursors = cursors.map(tr.changes); } catch (e) { return Decoration.none; }

            for (let e of tr.effects) {
                if (e.is(updateCursorEffect)) {
                    if (e.value.pos < 0 || e.value.pos > tr.newDoc.length) continue;
                    const deco = Decoration.widget({
                        widget: new CursorWidget(e.value.color, e.value.clientId),
                        side: 0,
                    }).range(e.value.pos);
                    cursors = cursors.update({
                        filter: (from, to, value) => (value.widget as any).label !== e.value.clientId,
                        add: [deco],
                    });
                }
                if (e.is(removeCursorEffect)) {
                    cursors = cursors.update({ filter: (from, to, value) => (value.widget as any).label !== e.value });
                }
            }
            return cursors;
        } catch (e) { return Decoration.none; }
    },
    provide: (f) => EditorView.decorations.from(f),
});

export default class SyncPlugin extends Plugin {
    settings: CyberSyncSettings;

    fileSocket: WebSocket | null = null;
    vaultSocket: WebSocket | null = null;

    private vaultMessageQueue: string[] = [];

    activeClientId: string;
    color: string = "#" + Math.floor(Math.random() * 16777215).toString(16);
    statusBarItem: HTMLElement;

    private isRequestingFullSync = false;
    private lastLocalChangeTime = 0;

    private isApplyingRemoteVaultAction = false;

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
            }, 5000)
        );

        this.updateStatusBar("disconnected");

        this.addSettingTab(new CyberSyncSettingTab(this.app, this));

        this.connectVaultSocket();

        this.registerEvent(this.app.vault.on("create", (file) => this.onLocalFileCreate(file)));
        this.registerEvent(this.app.vault.on("delete", (file) => this.onLocalFileDelete(file)));
        this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onLocalFileRename(file, oldPath)));

        const pluginInstance = this;
        const syncExtension = EditorView.updateListener.of((update: ViewUpdate) => {
            if (pluginInstance.fileSocket?.readyState !== WebSocket.OPEN) return;
            if (update.transactions.some(tr => tr.annotation(RemoteUpdate))) return;

            if (update.docChanged) {
                pluginInstance.lastLocalChangeTime = Date.now();
                pluginInstance.fileSocket.send(JSON.stringify({
                    type: "text_change",
                    changes: update.changes.toJSON(),
                    clientId: pluginInstance.activeClientId,
                }));
            }

            if (update.selectionSet) {
                if (!update.transactions.some(tr => tr.annotation(RemoteUpdate))) {
                    const pos = update.state.selection.main.head;
                    pluginInstance.fileSocket.send(JSON.stringify({
                        type: "cursor",
                        pos: pos,
                        color: pluginInstance.color,
                        clientId: pluginInstance.activeClientId,
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
        new Notice("CyberSync: Reconnecting...");
        if (this.vaultSocket) { this.vaultSocket.close(); this.vaultSocket = null; }
        if (this.fileSocket) { this.fileSocket.close(); this.fileSocket = null; }

        this.updateStatusBar("disconnected");

        setTimeout(() => {
            this.connectVaultSocket();
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) this.connectFileSocket(activeFile.path);
        }, 500);
    }

    updateStatusBar(forceStatus?: string) {
        this.statusBarItem.empty();
        const icon = this.statusBarItem.createSpan({ cls: "cybersync-status-icon" });

        let text = "";
        let color = "";

        if (forceStatus) {
            if (forceStatus === "connected") { text = "● CyberSync: OK"; color = "var(--text-success)"; }
            else if (forceStatus === "syncing") { text = "↻ CyberSync: Sync"; color = "var(--text-warning)"; }
            else if (forceStatus === "error") { text = "× CyberSync: Err"; color = "var(--text-error)"; }
            else { text = "● CyberSync: Off"; color = "var(--text-muted)"; }
        }
        else {
            const vaultReady = this.vaultSocket?.readyState === WebSocket.OPEN;
            const fileReady = this.fileSocket?.readyState === WebSocket.OPEN;
            const hasActiveFile = this.app.workspace.getActiveFile() !== null;

            if (vaultReady && (fileReady || !hasActiveFile)) {
                text = "● CyberSync: OK";
                color = "var(--text-success)";
            } else if (vaultReady && hasActiveFile && !fileReady) {
                text = "● CyberSync: No File";
                color = "var(--text-warning)";
            } else if (!vaultReady && fileReady) {
                text = "● CyberSync: No Vault";
                color = "var(--text-warning)";
            } else if (!vaultReady && !fileReady) {
                text = "× CyberSync: Off";
                color = "var(--text-muted)";
            } else {
                 text = "● CyberSync: Check";
                 color = "var(--text-muted)";
            }
        }

        icon.setText(text);
        icon.style.color = color;
    }

    sendVaultMessage(msg: any) {
        const json = JSON.stringify(msg);
        if (this.vaultSocket && this.vaultSocket.readyState === WebSocket.OPEN) {
            this.vaultSocket.send(json);
        } else {
            this.vaultMessageQueue.push(json);
        }
    }

    onLocalFileCreate(file: TAbstractFile) {
        if (this.isApplyingRemoteVaultAction) return;
        if (!(file instanceof TFile)) return;
        console.log("CyberSync: Local Create Detected ->", file.path);
        this.sendVaultMessage({ type: "file_created", path: file.path });
    }

    onLocalFileDelete(file: TAbstractFile) {
        if (this.isApplyingRemoteVaultAction) return;
        if (!(file instanceof TFile)) return;
        console.log("CyberSync: Local Delete Detected ->", file.path);
        this.sendVaultMessage({ type: "file_deleted", path: file.path });
    }

    onLocalFileRename(file: TAbstractFile, oldPath: string) {
        if (this.isApplyingRemoteVaultAction) return;
        if (!(file instanceof TFile)) return;
        console.log("CyberSync: Local Rename Detected ->", oldPath, "to", file.path);
        this.sendVaultMessage({ type: "file_renamed", path: file.path, oldPath: oldPath });
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
                console.log("CyberSync: 🌍✅ Connected to Global Vault!");
                this.updateStatusBar();

                while (this.vaultMessageQueue.length > 0) {
                    const msg = this.vaultMessageQueue.shift();
                    if (msg) this.vaultSocket?.send(msg);
                }
            };

            this.vaultSocket.onmessage = async (event) => {
                const data = JSON.parse(event.data);
                if (data.clientId === this.activeClientId) return;

                console.log("CyberSync: 🌍 Received Vault Event:", data.type, data.path);

                this.isApplyingRemoteVaultAction = true;
                try {
                    if (data.type === "vault_sync_init") {
                        const serverFiles: string[] = data.files || [];
                        console.log("CyberSync: Initial Sync. Files:", serverFiles.length);
                        for (const path of serverFiles) {
                            if (!this.app.vault.getAbstractFileByPath(path)) {
                                try {
                                    await this.createFolderRecursively(path);
                                    await this.app.vault.create(path, "");
                                    console.log("CyberSync: Synced missing file:", path);
                                } catch (e) { console.warn("Failed to sync file:", path, e); }
                            }
                        }
                    }
                    else if (data.type === "file_created") {
                        if (!this.app.vault.getAbstractFileByPath(data.path)) {
                            await this.createFolderRecursively(data.path);
                            await this.app.vault.create(data.path, "");
                            console.log("CyberSync: Remote Created ->", data.path);
                        }
                    }
                    else if (data.type === "file_deleted") {
                        const file = this.app.vault.getAbstractFileByPath(data.path);
                        if (file) {
                            await this.app.vault.delete(file);
                            console.log("CyberSync: Remote Deleted ->", data.path);
                        }
                    }
                    else if (data.type === "file_renamed") {
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
                console.log("CyberSync: 🌍 Vault Socket Closed");
                this.updateStatusBar("disconnected");
            };

            this.vaultSocket.onerror = (e) => {
                console.error("CyberSync: 🌍 Vault Socket Error", e);
                this.updateStatusBar("error");
            };

        } catch (e) {
            console.error("CyberSync: Vault Connect Failed", e);
            this.updateStatusBar("error");
        }
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

    connectFileSocket(filepath: string) {
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
                 const msg = JSON.parse(event.data);
                 if (msg.clientId === this.activeClientId && msg.type !== "ack") return;

                 if (msg.type === "text_change") {
                     const file = this.app.workspace.getActiveFile();
                     if (!file || file.path !== filepath) return;

                     const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                     if (!view) return;

                     // @ts-ignore
                     const cm = view.editor.cm as EditorView;
                     if (cm) {
                         try {
                             const changeSet = ChangeSet.fromJSON(msg.changes);
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
                 }
                 else if (msg.type === "ack") {
                     this.settings.fileVersions[filepath] = msg.version;
                     await this.saveSettings();
                 }
                 else if (msg.type === "full_sync") {
                     const file = this.app.workspace.getActiveFile();
                     if (file && file.path === filepath) {
                         const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                         if (view) {
                             view.editor.setValue(msg.content);
                             this.settings.fileVersions[filepath] = msg.version;
                             await this.saveSettings();
                         }
                     }
                 }
                 else if (msg.type === "cursor") {
                     const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                     // @ts-ignore
                     const cm = view?.editor?.cm as EditorView;
                     if (cm) {
                         cm.dispatch({
                             effects: updateCursorEffect.of({
                                 pos: msg.pos,
                                 clientId: msg.clientId,
                                 color: msg.color
                             })
                         });
                     }
                 }
                 else if (msg.type === "disconnect") {
                      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                      // @ts-ignore
                      const cm = view?.editor?.cm as EditorView;
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
            .setDesc("Address of the python server")
            .addText(text => text
                .setPlaceholder("ws://localhost:8000")
                .setValue(this.plugin.settings.serverUrl)
                .onChange(async (value) => {
                    this.plugin.settings.serverUrl = value;
                    await this.plugin.saveSettings();
                    this.plugin.forceReconnect();
                }));

        new Setting(containerEl)
            .setName("Client ID")
            .setDesc("Unique ID for this device")
            .addText(text => text
                .setPlaceholder("client-123")
                .setValue(this.plugin.settings.clientId)
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateActiveClientId();
                    this.plugin.forceReconnect();
                }));
    }
}
