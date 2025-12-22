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
            try {
                cursors = cursors.map(tr.changes);
            } catch (e) {
                return Decoration.none;
            }

            for (let e of tr.effects) {
                if (e.is(updateCursorEffect)) {
                    if (e.value.pos < 0 || e.value.pos > tr.newDoc.length)
                        continue;
                    const deco = Decoration.widget({
                        widget: new CursorWidget(
                            e.value.color,
                            e.value.clientId,
                        ),
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

    // ДВА СОКЕТА:
    fileSocket: WebSocket | null = null; // Для текста (меняется)
    vaultSocket: WebSocket | null = null; // Для файлов (вечный)

    activeClientId: string;
    color: string = "#" + Math.floor(Math.random() * 16777215).toString(16);
    statusBarItem: HTMLElement;

    private isRequestingFullSync = false;
    private lastLocalChangeTime = 0;

    // Флаг защиты от циклов для действий с файлами
    private isApplyingRemoteVaultAction = false;

    async onload() {
        await this.loadSettings();
        this.updateActiveClientId();

        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar("disconnected");

        this.addSettingTab(new CyberSyncSettingTab(this.app, this));

        // 1. Подключаем Глобальный Сокет (для файлов)
        this.connectVaultSocket();

        // 2. Слушаем события Obsidian (создание, удаление, переименование)
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

        // 3. Логика синхронизации текста
        const pluginInstance = this;
        const syncExtension = EditorView.updateListener.of(
            (update: ViewUpdate) => {
                // Используем fileSocket для текста
                if (pluginInstance.fileSocket?.readyState !== WebSocket.OPEN)
                    return;

                if (
                    update.transactions.some((tr) =>
                        tr.annotation(RemoteUpdate),
                    )
                )
                    return;

                if (update.docChanged) {
                    pluginInstance.lastLocalChangeTime = Date.now();
                    pluginInstance.fileSocket.send(
                        JSON.stringify({
                            type: "text_change",
                            changes: update.changes.toJSON(),
                            clientId: pluginInstance.activeClientId,
                        }),
                    );
                }

                if (update.selectionSet) {
                    if (
                        !update.transactions.some((tr) =>
                            tr.annotation(RemoteUpdate),
                        )
                    ) {
                        const pos = update.state.selection.main.head;
                        pluginInstance.fileSocket.send(
                            JSON.stringify({
                                type: "cursor",
                                pos: pos,
                                color: pluginInstance.color,
                                clientId: pluginInstance.activeClientId,
                            }),
                        );
                    }
                }
            },
        );

        this.registerEditorExtension([cursorField, syncExtension]);

        // При смене активного файла переподключаем fileSocket
        this.app.workspace.on("file-open", (file) => {
            if (file) this.connectFileSocket(file.path);
            else if (this.fileSocket) {
                this.fileSocket.close();
                this.fileSocket = null;
            }
        });

        // Если файл уже открыт
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) this.connectFileSocket(activeFile.path);
    }

    // --- ЛОГИКА VAULT SYNC (ОБРАБОТЧИКИ ЛОКАЛЬНЫХ СОБЫТИЙ) ---

    onLocalFileCreate(file: TAbstractFile) {
        if (this.isApplyingRemoteVaultAction) return;
        if (this.vaultSocket?.readyState !== WebSocket.OPEN) return;
        if (!(file instanceof TFile)) return; // Пока только файлы, папки можно добавить позже

        console.log("Local Create:", file.path);
        this.vaultSocket.send(
            JSON.stringify({
                type: "file_created",
                path: file.path,
            }),
        );
    }

    onLocalFileDelete(file: TAbstractFile) {
        if (this.isApplyingRemoteVaultAction) return;
        if (this.vaultSocket?.readyState !== WebSocket.OPEN) return;
        if (!(file instanceof TFile)) return;

        console.log("Local Delete:", file.path);
        this.vaultSocket.send(
            JSON.stringify({
                type: "file_deleted",
                path: file.path,
            }),
        );
    }

    onLocalFileRename(file: TAbstractFile, oldPath: string) {
        if (this.isApplyingRemoteVaultAction) return;
        if (this.vaultSocket?.readyState !== WebSocket.OPEN) return;
        if (!(file instanceof TFile)) return;

        console.log("Local Rename:", oldPath, "->", file.path);
        this.vaultSocket.send(
            JSON.stringify({
                type: "file_renamed",
                path: file.path,
                oldPath: oldPath,
            }),
        );
    }

    // --- ПОДКЛЮЧЕНИЕ ГЛОБАЛЬНОГО СОКЕТА ---
    connectVaultSocket() {
        const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
        const url = `${baseUrl}/ws?file_id=__global__&client_id=${encodeURIComponent(this.activeClientId)}`;

        try {
            this.vaultSocket = new WebSocket(url);

            this.vaultSocket.onopen = () => {
                console.log("CyberSync: Connected to Global Vault");
                // Можно отправить приветственное сообщение, но сервер сам пришлет init
            };

            this.vaultSocket.onmessage = async (event) => {
                const data = JSON.parse(event.data);
                if (data.clientId === this.activeClientId) return; // Игнор своих сообщений

                this.isApplyingRemoteVaultAction = true;
                try {
                    // 1. Инициализация (пришли все файлы)
                    if (data.type === "vault_sync_init") {
                        const serverFiles: string[] = data.files || [];
                        console.log("Vault Init. Files:", serverFiles.length);
                        // Простая стратегия: если файла нет у нас - создаем пустой
                        for (const path of serverFiles) {
                            if (!this.app.vault.getAbstractFileByPath(path)) {
                                try {
                                    await this.createFolderRecursively(path);
                                    await this.app.vault.create(path, "");
                                    console.log("Synced missing file:", path);
                                } catch (e) {
                                    console.warn(
                                        "Failed to sync file:",
                                        path,
                                        e,
                                    );
                                }
                            }
                        }
                    }
                    // 2. Создание
                    else if (data.type === "file_created") {
                        if (!this.app.vault.getAbstractFileByPath(data.path)) {
                            await this.createFolderRecursively(data.path);
                            await this.app.vault.create(data.path, "");
                            new Notice(`Remote created: ${data.path}`);
                        }
                    }
                    // 3. Удаление
                    else if (data.type === "file_deleted") {
                        const file = this.app.vault.getAbstractFileByPath(
                            data.path,
                        );
                        if (file) {
                            await this.app.vault.delete(file);
                            new Notice(`Remote deleted: ${data.path}`);
                        }
                    }
                    // 4. Переименование
                    else if (data.type === "file_renamed") {
                        const file = this.app.vault.getAbstractFileByPath(
                            data.oldPath,
                        );
                        if (file) {
                            await this.createFolderRecursively(data.path);
                            await this.app.vault.rename(file, data.path);
                            new Notice(
                                `Remote renamed: ${data.oldPath} -> ${data.path}`,
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
                console.log("Vault Socket closed. Reconnecting in 5s...");
                setTimeout(() => this.connectVaultSocket(), 5000);
            };
        } catch (e) {
            console.error("Failed to connect Vault Socket", e);
        }
    }

    async createFolderRecursively(path: string) {
        const folders = path.split("/").slice(0, -1);
        if (folders.length === 0) return;

        let currentPath = "";
        for (const folder of folders) {
            currentPath =
                currentPath === "" ? folder : `${currentPath}/${folder}`;
            if (!this.app.vault.getAbstractFileByPath(currentPath)) {
                await this.app.vault.createFolder(currentPath);
            }
        }
    }

    // --- ОБЫЧНЫЕ ФУНКЦИИ (TEXT SYNC) ---

    async updateLocalVersion(filePath: string, version: number) {
        this.settings.fileVersions[filePath] = version;
        await this.saveSettings();
    }

    getLocalVersion(filePath: string): number {
        return this.settings.fileVersions[filePath] || 0;
    }

    updateActiveClientId() {
        this.activeClientId =
            this.settings.clientId?.trim() ||
            "User_" + Math.floor(Math.random() * 1000);
    }

    updateStatusBar(status: string) {
        this.statusBarItem.empty();
        const icon = this.statusBarItem.createSpan({
            cls: "cybersync-status-icon",
        });
        let text = "● CyberSync: Off";
        let color = "var(--text-muted)";

        if (status === "connected") {
            text = "● CyberSync: OK";
            color = "var(--text-success)";
        } else if (status === "syncing") {
            text = "↻ CyberSync: Sync";
            color = "var(--text-warning)";
        } else if (status === "error") {
            text = "× CyberSync: Err";
            color = "var(--text-error)";
        }

        icon.setText(text);
        icon.style.color = color;
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData(),
        );
        if (!this.settings.fileVersions) this.settings.fileVersions = {};
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    hasConflictMarkers(text: string): boolean {
        return /^<<<<<<< REMOTE \(Server v\d+\)/m.test(text);
    }

    normalizeText(text: string): string {
        return text.replace(/\r\n/g, "\n");
    }

    connectFileSocket(fileId: string) {
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
                console.log(`CyberSync: File Connected ${fileId}`);
                this.updateStatusBar("connected");
                const currentVer = this.getLocalVersion(fileId) || 0;
                this.fileSocket?.send(
                    JSON.stringify({
                        type: "handshake",
                        version: Number(currentVer),
                    }),
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
                const data = JSON.parse(event.data);
                const view =
                    this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return;
                const file = view.file;
                if (!file) return;
                const cm = (view.editor as any).cm as EditorView;

                if (data.type === "text_change") {
                    if (this.isRequestingFullSync) return;
                    const localVer = this.getLocalVersion(file.path);
                    if (data.version && data.version <= localVer) return;
                    if (
                        data.clientId === this.activeClientId &&
                        !data.is_history
                    )
                        return;

                    if (data.is_history) this.updateStatusBar("syncing");

                    try {
                        const changes = ChangeSet.fromJSON(data.changes);
                        if (changes.length !== cm.state.doc.length) {
                            this.requestFullSync(file.path);
                            return;
                        }
                        cm.dispatch({
                            changes: changes,
                            scrollIntoView: !data.is_history,
                            annotations: [RemoteUpdate.of(true)],
                        });
                        if (data.version)
                            await this.updateLocalVersion(
                                file.path,
                                data.version,
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
                            cm.state.doc.toString(),
                        );
                        this.fileSocket?.send(
                            JSON.stringify({
                                type: "snapshot_hint",
                                version: ver,
                                content: content,
                            }),
                        );
                    }
                } else if (data.type === "full_sync") {
                    this.isRequestingFullSync = false;
                    try {
                        const serverContent = this.normalizeText(
                            data.content || "",
                        );
                        const localContent = this.normalizeText(
                            cm.state.doc.toString(),
                        );
                        const serverVer = Number(data.version || 0);
                        const normalize = (str: string) =>
                            str.replace(/\s+$/, "");

                        if (serverContent === localContent) {
                            await this.updateLocalVersion(file.path, serverVer);
                        } else if (
                            normalize(serverContent) === normalize(localContent)
                        ) {
                            cm.dispatch({
                                changes: {
                                    from: 0,
                                    to: cm.state.doc.length,
                                    insert: serverContent,
                                },
                                scrollIntoView: false,
                                annotations: [RemoteUpdate.of(true)],
                            });
                            await this.updateLocalVersion(file.path, serverVer);
                        } else {
                            const timeSinceEdit =
                                Date.now() - this.lastLocalChangeTime;
                            const isUserIdle = timeSinceEdit > 3000;
                            const serverHasMarkers =
                                this.hasConflictMarkers(serverContent);
                            const localHasMarkers =
                                this.hasConflictMarkers(localContent);

                            if (
                                isUserIdle ||
                                (!serverHasMarkers && localHasMarkers)
                            ) {
                                cm.dispatch({
                                    changes: {
                                        from: 0,
                                        to: cm.state.doc.length,
                                        insert: serverContent,
                                    },
                                    scrollIntoView: false,
                                    annotations: [RemoteUpdate.of(true)],
                                });
                                await this.updateLocalVersion(
                                    file.path,
                                    serverVer,
                                );
                            } else {
                                const conflictText = `<<<<<<< REMOTE (Server v${serverVer})\n${serverContent}\n=======\n${localContent}\n>>>>>>> LOCAL (My changes)\n`;
                                cm.dispatch({
                                    changes: {
                                        from: 0,
                                        to: cm.state.doc.length,
                                        insert: conflictText,
                                    },
                                    scrollIntoView: false,
                                    annotations: [RemoteUpdate.of(true)],
                                });
                                await this.updateLocalVersion(
                                    file.path,
                                    serverVer,
                                );
                                new Notice("CyberSync: Conflict detected.");
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
                            color: data.color,
                        }),
                        annotations: [RemoteUpdate.of(true)],
                    });
                } else if (data.type === "disconnect") {
                    cm.dispatch({
                        effects: removeCursorEffect.of(data.clientId),
                        annotations: [RemoteUpdate.of(true)],
                    });
                }
            };
        } catch (e) {
            this.updateStatusBar("error");
            this.isRequestingFullSync = false;
        }
    }

    onunload() {
        if (this.fileSocket) this.fileSocket.close();
        if (this.vaultSocket) this.vaultSocket.close();
    }
}

class CyberSyncSettingTab extends PluginSettingTab {
    plugin: SyncPlugin;
    constructor(app: App, plugin: SyncPlugin) {
        super(app, plugin);
    }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "CyberSync Settings" });
        new Setting(containerEl).setName("Server URL").addText((text) =>
            text
                .setValue(this.plugin.settings.serverUrl)
                .onChange(async (v) => {
                    this.plugin.settings.serverUrl = v;
                    await this.plugin.saveSettings();
                }),
        );
        new Setting(containerEl).setName("Client ID").addText((text) =>
            text.setValue(this.plugin.settings.clientId).onChange(async (v) => {
                this.plugin.settings.clientId = v;
                await this.plugin.saveSettings();
            }),
        );
        new Setting(containerEl)
            .setName("Reset Local Versions")
            .setDesc("Dangerous")
            .addButton((btn) =>
                btn
                    .setButtonText("Reset Cache")
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.fileVersions = {};
                        await this.plugin.saveSettings();
                        new Notice("Local version cache cleared");
                    }),
            );
    }
}
