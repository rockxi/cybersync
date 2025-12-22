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
}

const DEFAULT_SETTINGS: CyberSyncSettings = {
    serverUrl: "ws://localhost:8000",
    clientId: "",
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
    private isApplyingRemoteChange = false;

    async onload() {
        await this.loadSettings();
        this.updateActiveClientId();

        // Создаем элемент в статус-баре
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar("disconnected");

        this.addSettingTab(new CyberSyncSettingTab(this.app, this));

        const pluginInstance = this;
        const syncExtension = EditorView.updateListener.of(
            (update: ViewUpdate) => {
                if (pluginInstance.socket?.readyState !== WebSocket.OPEN)
                    return;

                if (update.docChanged && !this.isApplyingRemoteChange) {
                    pluginInstance.socket.send(
                        JSON.stringify({
                            type: "text_change",
                            changes: update.changes.toJSON(),
                            clientId: pluginInstance.activeClientId,
                        }),
                    );
                }

                if (update.selectionSet) {
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

        this.app.workspace.on("file-open", (file) => {
            if (file) this.connectSocket(file.path);
        });

        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) this.connectSocket(activeFile.path);
    }

    updateActiveClientId() {
        this.activeClientId =
            this.settings.clientId?.trim() ||
            "User_" + Math.floor(Math.random() * 1000);
    }

    updateStatusBar(
        status: "connected" | "disconnected" | "connecting" | "error",
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
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.updateActiveClientId();
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) this.connectSocket(activeFile.path);
    }

    connectSocket(fileId: string) {
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
                const view =
                    this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || data.clientId === this.activeClientId) return;

                const cm = (view.editor as any).cm as EditorView;

                if (data.type === "text_change") {
                    this.isApplyingRemoteChange = true;
                    try {
                        cm.dispatch({
                            changes: ChangeSet.fromJSON(data.changes),
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
    }
}
