import {
    App,
    Plugin,
    PluginSettingTab,
    Setting,
    MarkdownView,
    TFile,
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
                console.log("CyberSync connected");

                // --- HANDSHAKE ---
                // Отправляем серверу текущую известную нам версию этого файла
                const currentVer = this.getLocalVersion(fileId);
                this.socket?.send(
                    JSON.stringify({
                        type: "handshake",
                        version: currentVer,
                    }),
                );

                this.updateStatusBar("connected");
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

                // Если мы получили сообщение для файла, который уже закрыт (гонка состояний), игнорируем
                if (!view) return;

                const cm = (view.editor as any).cm as EditorView;

                if (data.type === "text_change") {
                    // Игнорируем свои же сообщения, если они пришли как "эхо" (хотя broadcast фильтрует)
                    // Но если это history replay, то clientId может быть наш (с прошлой сессии), но применить надо
                    if (
                        data.clientId === this.activeClientId &&
                        !data.is_history
                    )
                        return;

                    this.isApplyingRemoteChange = true;
                    if (data.is_history) this.updateStatusBar("syncing");

                    try {
                        const changes = ChangeSet.fromJSON(data.changes);
                        cm.dispatch({
                            changes: changes,
                            // Важно: scrollIntoView: false, чтобы экран не прыгал при загрузке истории
                            scrollIntoView: !data.is_history,
                        });

                        // Если есть версия, обновляем локальную
                        if (data.version) {
                            await this.updateLocalVersion(fileId, data.version);
                        }
                    } catch (e) {
                        console.error("Failed to apply remote change", e);
                        // Если произошла ошибка (рассинхрон), в реальном проекте здесь нужно запросить Full Sync
                    } finally {
                        this.isApplyingRemoteChange = false;
                        if (data.is_history) this.updateStatusBar("connected");
                    }
                } else if (data.type === "ack") {
                    // Сервер подтвердил наше изменение и присвоил ему версию
                    if (data.version) {
                        await this.updateLocalVersion(fileId, data.version);
                    }
                } else if (data.type === "cursor") {
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

        // Кнопка сброса версий (для отладки)
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
