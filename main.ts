import { App, Plugin, PluginSettingTab, Setting, MarkdownView } from "obsidian";
import { Extension, StateField, StateEffect } from "@codemirror/state";
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
    clientId: string; // Новое поле
}

const DEFAULT_SETTINGS: CyberSyncSettings = {
    serverUrl: "ws://localhost:8000",
    clientId: "", // По умолчанию пусто, будет генерироваться случайно
};

// --- ТИПЫ ДАННЫХ ---
interface CursorPosition {
    pos: number;
    clientId: string;
    color: string;
}

// --- ЭФФЕКТЫ ---
const updateCursorEffect = StateEffect.define<CursorPosition>();
const removeCursorEffect = StateEffect.define<string>();

// --- ВИДЖЕТ ---
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

// --- STATE FIELD ---
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
                    filter: (from, to, value) => {
                        // @ts-ignore
                        return value.widget.label !== e.value.clientId;
                    },
                    add: [deco],
                });
            }
            if (e.is(removeCursorEffect)) {
                cursors = cursors.update({
                    filter: (from, to, value) => {
                        // @ts-ignore
                        return value.widget.label !== e.value;
                    },
                });
            }
        }
        return cursors;
    },
    provide: (f) => EditorView.decorations.from(f),
});

// --- ГЛАВНЫЙ КЛАСС ПЛАГИНА ---
export default class SyncPlugin extends Plugin {
    settings: CyberSyncSettings;
    socket: WebSocket | null = null;
    activeClientId: string; // ID, который используется в текущей сессии
    color: string = "#" + Math.floor(Math.random() * 16777215).toString(16);

    async onload() {
        await this.loadSettings();

        // Устанавливаем ID: из настроек или генерируем новый
        this.updateActiveClientId();

        this.addSettingTab(new CyberSyncSettingTab(this.app, this));

        const pluginInstance = this;
        const socketListener = ViewPlugin.fromClass(
            class {
                constructor(public view: EditorView) {}
                update(update: ViewUpdate) {
                    if (
                        update.selectionSet &&
                        pluginInstance.socket?.readyState === WebSocket.OPEN
                    ) {
                        const pos = update.state.selection.main.head;
                        pluginInstance.socket.send(
                            JSON.stringify({
                                type: "cursor",
                                pos: pos,
                                color: pluginInstance.color,
                            }),
                        );
                    }
                }
            },
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
            this.activeClientId = "User_" + Math.floor(Math.random() * 1000);
        }
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData(),
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.updateActiveClientId(); // Обновляем рабочий ID

        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            this.connectSocket(activeFile.path);
        }
    }

    connectSocket(fileId: string) {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }

        const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
        const encodedId = encodeURIComponent(fileId);
        // Используем activeClientId
        const url = `${baseUrl}/ws/${encodedId}/${encodeURIComponent(this.activeClientId)}`;

        console.log("Connecting to:", url, "as", this.activeClientId);

        try {
            this.socket = new WebSocket(url);

            this.socket.onopen = () => console.log("CyberSync connected");

            this.socket.onmessage = (event) => {
                const data = JSON.parse(event.data);
                const view =
                    this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return;

                // Фильтр своего эха
                if (data.clientId === this.activeClientId) return;

                if (data.type === "cursor") {
                    view.editor.cm.dispatch({
                        effects: updateCursorEffect.of({
                            pos: data.pos,
                            clientId: data.clientId,
                            color: data.color,
                        }),
                    });
                } else if (data.type === "disconnect") {
                    view.editor.cm.dispatch({
                        effects: removeCursorEffect.of(data.clientId),
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
}

// --- UI НАСТРОЕК ---
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
                    }),
            );

        new Setting(containerEl)
            .setName("Client ID")
            .setDesc(
                "Your nickname shown to others. Leave empty for random ID.",
            )
            .addText((text) =>
                text
                    .setPlaceholder("Enter your name")
                    .setValue(this.plugin.settings.clientId)
                    .onChange(async (value) => {
                        this.plugin.settings.clientId = value;
                        await this.plugin.saveSettings();
                    }),
            );
    }
}
