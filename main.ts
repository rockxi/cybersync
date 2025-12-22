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
    socket: WebSocket | null = null;
    activeClientId: string;
    color: string = "#" + Math.floor(Math.random() * 16777215).toString(16);
    statusBarItem: HTMLElement;

    private isRequestingFullSync = false;

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

                if (
                    update.transactions.some((tr) =>
                        tr.annotation(RemoteUpdate),
                    )
                ) {
                    return;
                }

                if (update.docChanged) {
                    pluginInstance.socket.send(
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
                        pluginInstance.socket.send(
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

        this.app.workspace.on("file-open", (file) => {
            if (file) this.connectSocket(file.path);
        });

        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) this.connectSocket(activeFile.path);
    }

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

    requestFullSync(fileId: string) {
        if (this.isRequestingFullSync) return;
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

        this.isRequestingFullSync = true;
        this.updateStatusBar("syncing");

        this.socket.send(
            JSON.stringify({
                type: "full_sync",
            }),
        );

        setTimeout(() => {
            if (this.isRequestingFullSync) {
                this.isRequestingFullSync = false;
                this.updateStatusBar("connected");
            }
        }, 5000);
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

    // --- НОРМАЛИЗАЦИЯ (LF) ---
    normalizeText(text: string): string {
        return text.replace(/\r\n/g, "\n");
    }

    connectSocket(fileId: string) {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }

        this.isRequestingFullSync = false;
        this.updateStatusBar("connecting");

        const baseUrl = this.settings.serverUrl.replace(/\/$/, "");
        const url = `${baseUrl}/ws/${encodeURIComponent(fileId)}/${encodeURIComponent(this.activeClientId)}`;

        try {
            this.socket = new WebSocket(url);

            this.socket.onopen = () => {
                console.log(`CyberSync: Connected to ${fileId}`);
                this.updateStatusBar("connected");
                const currentVer = this.getLocalVersion(fileId) || 0;

                this.socket?.send(
                    JSON.stringify({
                        type: "handshake",
                        version: Number(currentVer),
                    }),
                );
            };

            this.socket.onclose = () => {
                this.updateStatusBar("disconnected");
                this.isRequestingFullSync = false;
            };

            this.socket.onerror = () => {
                this.updateStatusBar("error");
                this.isRequestingFullSync = false;
            };

            this.socket.onmessage = async (event) => {
                const data = JSON.parse(event.data);
                const view =
                    this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view) return;
                const file = view.file;
                if (!file) return;
                const cm = (view.editor as any).cm as EditorView;

                // --- TEXT CHANGE ---
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
                }

                // --- ACK ---
                else if (data.type === "ack") {
                    const ver = Number(data.version || 0);
                    if (ver) {
                        await this.updateLocalVersion(file.path, ver);
                        // ВАЖНО: Нормализуем перед отправкой!
                        const content = this.normalizeText(
                            cm.state.doc.toString(),
                        );
                        this.socket?.send(
                            JSON.stringify({
                                type: "snapshot_hint",
                                version: ver,
                                content: content,
                            }),
                        );
                    }
                }

                // --- FULL SYNC ---
                else if (data.type === "full_sync") {
                    this.isRequestingFullSync = false;

                    try {
                        const serverContent = this.normalizeText(
                            data.content || "",
                        );
                        const localContent = this.normalizeText(
                            cm.state.doc.toString(),
                        );
                        const serverVer = Number(data.version || 0);

                        console.log(
                            `CyberSync: Applying Full Sync v${serverVer}`,
                        );

                        if (serverContent === localContent) {
                            await this.updateLocalVersion(file.path, serverVer);
                            console.log("CyberSync: Full sync matched.");
                        } else if (
                            serverContent.trimEnd() === localContent.trimEnd()
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
                            const serverHasMarkers =
                                this.hasConflictMarkers(serverContent);
                            const localHasMarkers =
                                this.hasConflictMarkers(localContent);

                            if (!serverHasMarkers && localHasMarkers) {
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
                                new Notice(
                                    "CyberSync: Conflict resolved remotely.",
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
                                        insert: conflictText,
                                    },
                                    scrollIntoView: false,
                                    annotations: [RemoteUpdate.of(true)],
                                });

                                await this.updateLocalVersion(
                                    file.path,
                                    serverVer,
                                );
                                new Notice(
                                    "CyberSync: Conflict detected. Resolve manually.",
                                );
                            }
                        }
                    } catch (e) {
                        console.error("Full sync failed", e);
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
        new Setting(containerEl).setName("Client ID").addText((text) =>
            text.setValue(this.plugin.settings.clientId).onChange(async (v) => {
                this.plugin.settings.clientId = v;
                await this.plugin.saveSettings();
            }),
        );
        new Setting(containerEl)
            .setName("Reset Local Versions")
            .setDesc("Dangerous: Will force re-download")
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
