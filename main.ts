import {
    App,
    Plugin,
    PluginSettingTab,
    Setting,
    MarkdownView,
    TFile,
    Notice,
} from "obsidian";
import {
    Extension,
    StateField,
    StateEffect,
    ChangeSet,
    Transaction,
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
    // Словарь: путь_к_файлу -> номер_версии
    fileVersions: Record<string, number>;
}

const DEFAULT_SETTINGS: CyberSyncSettings = {
    serverUrl: "ws://localhost:8000",
    clientId: "",
    fileVersions: {},
};

// --- ТИПЫ ДАННЫХ ---
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
        cursors = cursors.map(tr.changes);
        for (let e of tr.effects) {
            if (e.is(updateCursorEffect)) {
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
    },
    provide: (f) => EditorView.decorations.from(f),
});

export default class SyncPlugin extends Plugin {
    settings: CyberSyncSettings;
    socket: WebSocket | null = null;
    activeClientId: string;
    color: string = "#" + Math.floor(Math.random() * 16777215).toString(16);
    statusBarItem: HTMLElement;

    // Флаг, чтобы не отправлять свои изменения, пока мы применяем чужие
    private isApplyingRemoteChange = false;
    // Флаг, что мы сейчас загружаем историю (чтобы не спамить в консоль)
    private isSyncingHistory = false;

    async onload() {
        await this.loadSettings();
        this.updateActiveClientId();

        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar("disconnected");

        this.addSettingTab(new CyberSyncSettingTab(this.app, this));

        const pluginInstance = this;
        const syncExtension = EditorView.updateListener.of(
            (update: ViewUpdate) => {
                if (pluginInstance.socket?.readyState !== WebSocket.OPEN)
                    return;

                // Отправляем изменения ТОЛЬКО если это пользовательский ввод
                // и мы не находимся в процессе применения серверных патчей
                if (
                    update.docChanged &&
                    !this.isApplyingRemoteChange &&
                    update.transactions.some(
                        (tr) =>
                            tr.isUserEvent("input") ||
                            tr.isUserEvent("delete") ||
                            tr.isUserEvent("undo") ||
                            tr.isUserEvent("redo"),
                    )
                ) {
                    pluginInstance.socket.send(
                        JSON.stringify({
                            type: "text_change",
                            changes: update.changes.toJSON(),
                            clientId: pluginInstance.activeClientId,
                        }),
                    );
                }

                // Для курсоров
                if (update.selectionSet && !this.isApplyingRemoteChange) {
                    const pos = update.state.selection.main.head;
                    pluginInstance.socket.send(
                        JSON.stringify({
                            type: "cursor",
                            pos: pos,
                            color: pluginInstance.color,
                            clientId: pluginInstance.activeClientId,
                        }),
                    );
                }
            },
        );

        this.registerEditorExtension([cursorField, syncExtension]);

        // При открытии файла подключаемся
        this.app.workspace.on("file-open", (file) => {
            if (file) this.connectSocket(file.path);
        });

        // Если файл уже открыт при старте
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) this.connectSocket(activeFile.path);
    }

    async updateLocalVersion(filePath: string, version: number) {
        this.settings.fileVersions[filePath] = version;
        await this.saveSettings(); // Сохраняем в файл, чтобы пережить перезапуск
    }

    getLocalVersion(filePath: string): number {
        return this.settings.fileVersions[filePath] || 0;
    }

    updateActiveClientId() {
        this.activeClientId =
            this.settings.clientId?.trim() ||
            "User_" + Math.floor(Math.random() * 1000);
    }

    updateStatusBar(
        status:
            | "connected"
            | "disconnected"
            | "connecting"
            | "error"
            | "syncing",
    ) {
        this.statusBarItem.empty();
        const icon = this.statusBarItem.createSpan({
            cls: "cybersync-status-icon",
        });

        switch (status) {
            case "connected":
                icon.setText("● CyberSync: OK");
                icon.style.color = "var(--text-success)";
                break;
            case "connecting":
                icon.setText("○ CyberSync: ...");
                icon.style.color = "var(--text-accent)";
                break;
            case "syncing":
                icon.setText("↻ CyberSync: Sync");
                icon.style.color = "var(--text-warning)";
                break;
            case "error":
                icon.setText("× CyberSync: Err");
                icon.style.color = "var(--text-error)";
                break;
            case "disconnected":
                icon.setText("● CyberSync: Off");
                icon.style.color = "var(--text-muted)";
                break;
        }
    }

    requestFullSync(fileId: string) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        console.log("CyberSync: Requesting Full Sync (Conflict Resolution)...");
        this.updateStatusBar("syncing");
        this.socket.send(
            JSON.stringify({
                type: "full_sync",
            }),
        );
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData(),
        );
        // Инициализируем объект версий если он пуст
        if (!this.settings.fileVersions) this.settings.fileVersions = {};
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    connectSocket(fileId: string) {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }

        this.updateStatusBar("connecting");
        const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
        const url = `${baseUrl}/ws/${encodeURIComponent(fileId)}/${encodeURIComponent(this.activeClientId)}`;

        try {
            this.socket = new WebSocket(url);

            this.socket.onopen = () => {
                console.log(`CyberSync: Connected to ${fileId}`);
                this.updateStatusBar("connected");

                // --- HANDSHAKE ---
                const currentVer = this.getLocalVersion(fileId) || 0;
                console.log(
                    `CyberSync: Sending handshake for ${fileId}, local version: ${currentVer}`,
                );

                this.socket?.send(
                    JSON.stringify({
                        type: "handshake",
                        version: Number(currentVer),
                    }),
                );
            };

            this.socket.onclose = () => {
                this.updateStatusBar("disconnected");
            };

            this.socket.onerror = () => {
                this.updateStatusBar("error");
            };

            this.socket.onmessage = async (event) => {
                const data = JSON.parse(event.data);
                const view =
                    this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return;

                const file = view.file;
                if (!file) return; // Защита если файл закрыли
                const cm = (view.editor as any).cm as EditorView;

                // --- ОБРАБОТКА ИЗМЕНЕНИЙ (Delta) ---
                if (data.type === "text_change") {
                    if (
                        data.clientId === this.activeClientId &&
                        !data.is_history
                    )
                        return;

                    this.isApplyingRemoteChange = true;
                    if (data.is_history) this.updateStatusBar("syncing");

                    try {
                        const changes = ChangeSet.fromJSON(data.changes);

                        // ПРОВЕРКА ЦЕЛОСТНОСТИ: Совпадает ли длина документа?
                        if (changes.length !== cm.state.doc.length) {
                            console.warn(
                                `CyberSync: Document length mismatch! Remote expects ${changes.length}, local is ${cm.state.doc.length}. Requesting Full Sync.`,
                            );
                            this.requestFullSync(file.path);
                            return; // Прерываем обработку, ждем full_sync
                        }

                        cm.dispatch({
                            changes: changes,
                            scrollIntoView: !data.is_history,
                        });

                        if (data.version) {
                            await this.updateLocalVersion(
                                file.path,
                                data.version,
                            );
                        }
                    } catch (e) {
                        console.error(
                            "CyberSync: Failed to apply remote change (RangeError?)",
                            e,
                        );
                        // Если CodeMirror выбросил ошибку при применении - тоже запрашиваем Full Sync
                        this.requestFullSync(file.path);
                    } finally {
                        this.isApplyingRemoteChange = false;
                        if (data.is_history) this.updateStatusBar("connected");
                    }
                }

                // --- ПОДТВЕРЖДЕНИЕ ЗАПИСИ (ACK) ---
                else if (data.type === "ack") {
                    const ver = Number(data.version || 0);
                    if (ver) {
                        await this.updateLocalVersion(file.path, ver);

                        // SNAPSHOT HINT: Отправляем серверу полный текст, чтобы он обновил бэкап
                        // Это нужно, чтобы сервер всегда мог отдать "full_sync"
                        const content = cm.state.doc.toString();
                        this.socket?.send(
                            JSON.stringify({
                                type: "snapshot_hint",
                                version: ver,
                                content: content,
                            }),
                        );
                    }
                }

                // --- FULL SYNC (Решение конфликтов) ---
                else if (data.type === "full_sync") {
                    this.isApplyingRemoteChange = true;
                    try {
                        const serverContent = data.content || "";
                        const localContent = cm.state.doc.toString();
                        const serverVer = Number(data.version || 0);

                        // Если контент совпадает, просто обновляем версию
                        if (serverContent === localContent) {
                            await this.updateLocalVersion(file.path, serverVer);
                            console.log(
                                "CyberSync: Full sync content matches, version updated.",
                            );
                        } else {
                            // КОНФЛИКТ: Вставляем маркеры как в Git
                            const conflictText = `<<<<<<< REMOTE (Server v${serverVer})
${serverContent}
=======
${localContent}
>>>>>>> LOCAL (My changes)
`;
                            // Заменяем весь текст на блок с конфликтом
                            cm.dispatch({
                                changes: {
                                    from: 0,
                                    to: localContent.length,
                                    insert: conflictText,
                                },
                                scrollIntoView: false,
                            });

                            // Принимаем версию сервера как базу
                            await this.updateLocalVersion(file.path, serverVer);
                            new Notice(
                                "CyberSync: Conflict detected! Merged with markers.",
                            );
                        }
                    } catch (e) {
                        console.error(
                            "CyberSync: Failed to apply full_sync",
                            e,
                        );
                    } finally {
                        this.isApplyingRemoteChange = false;
                        this.updateStatusBar("connected");
                    }
                }

                // --- КУРСОРЫ ---
                else if (data.type === "cursor") {
                    if (data.clientId === this.activeClientId) return;
                    cm.dispatch({
                        effects: updateCursorEffect.of({
                            pos: data.pos,
                            clientId: data.clientId,
                            color: data.color,
                        }),
                    });
                } else if (data.type === "disconnect") {
                    cm.dispatch({
                        effects: removeCursorEffect.of(data.clientId),
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
        new Setting(containerEl).setName("Server URL").addText((text) =>
            text
                .setValue(this.plugin.settings.serverUrl)
                .onChange(async (v) => {
                    this.plugin.settings.serverUrl = v;
                    await this.plugin.saveSettings();
                }),
        );
        new Setting(containerEl)
            .setName("Client ID")
            .setDesc("Nickname for sync")
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.clientId)
                    .onChange(async (v) => {
                        this.plugin.settings.clientId = v;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName("Reset Local Versions")
            .setDesc(
                "Dangerous: Will force re-download of history on next open",
            )
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
