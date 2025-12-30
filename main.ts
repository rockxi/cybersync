import {
    App,
    Plugin,
    PluginSettingTab,
    Setting,
    MarkdownView,
    TFile,
    TAbstractFile,
    WorkspaceLeaf,
    Notice,
    Vault,
} from "obsidian";
import {
    EditorView,
    WidgetType,
    Decoration,
    DecorationSet,
} from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { toBase64, fromBase64 } from "lib0/buffer";

// --- SETTINGS ---
interface CyberSyncSettings {
    serverUrl: string;
    clientId: string;
}
const DEFAULT_SETTINGS: CyberSyncSettings = {
    serverUrl: "ws://localhost:8000",
    clientId: "",
};

// --- CURSOR WIDGETS (Standard CodeMirror logic) ---
interface RemoteCursor {
    clientId: string;
    color: string;
    name: string;
    pos: number;
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
        wrap.className = "cybersync-cursor";
        wrap.style.borderLeft = `2px solid ${this.color}`;
        wrap.style.position = "absolute";
        wrap.style.height = "1.2em";
        wrap.style.marginTop = "-0.2em";
        const label = document.createElement("div");
        label.textContent = this.label;
        label.style.backgroundColor = this.color;
        label.style.color = "white";
        label.style.fontSize = "10px";
        label.style.position = "absolute";
        label.style.top = "-1.2em";
        label.style.padding = "0 2px";
        wrap.appendChild(label);
        return wrap;
    }
}
const cursorField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, tr) {
        decorations = decorations.map(tr.changes);
        for (let e of tr.effects)
            if (e.is(cursorEffect)) {
                decorations = Decoration.set(
                    e.value.map((c) =>
                        Decoration.widget({
                            widget: new CursorWidget(c.color, c.name),
                            side: 0,
                        }).range(c.pos),
                    ),
                    true,
                );
            }
        return decorations;
    },
    provide: (f) => EditorView.decorations.from(f),
});

// --- CLASS: VAULT SYNC MANAGER ---
// Отвечает за синхронизацию дерева файлов (создание/удаление)
class VaultSyncManager {
    doc: Y.Doc;
    filesMap: Y.Map<any>; // Key: path, Value: { status: 'active' | 'deleted' }
    plugin: SyncPlugin;
    isProcessingRemote: boolean = false; // Флаг, чтобы не зацикливать события

    constructor(plugin: SyncPlugin) {
        this.plugin = plugin;
        this.doc = new Y.Doc();
        this.filesMap = this.doc.getMap("files");

        // Подписываемся на обновления Yjs (пришедшие с сервера)
        this.doc.on("update", (update, origin) => {
            // Если обновление пришло не от нас (не локально), применяем к файловой системе
            if (origin !== "local") {
                this.reconcileVault();
            }
        });
    }

    // Сравнить Yjs Map и реальный диск
    async reconcileVault() {
        this.isProcessingRemote = true;
        try {
            const remoteFiles = this.filesMap.toJSON();
            const localFiles = this.plugin.app.vault.getFiles();
            const localPaths = new Set(localFiles.map((f) => f.path));

            for (const [path, meta] of Object.entries(remoteFiles)) {
                // @ts-ignore
                if (meta.status === "active") {
                    if (!localPaths.has(path)) {
                        // Файл есть на сервере, но нет у нас -> Создаем
                        // Создаем пустой файл. Контент подтянется, когда пользователь откроет его
                        // или через отдельный процесс background sync (здесь для простоты - on open)
                        const folderPath = path.substring(
                            0,
                            path.lastIndexOf("/"),
                        );
                        if (
                            folderPath &&
                            !this.plugin.app.vault.getAbstractFileByPath(
                                folderPath,
                            )
                        ) {
                            await this.plugin.app.vault.createFolder(
                                folderPath,
                            );
                        }
                        await this.plugin.app.vault.create(path, "");
                        new Notice(`[CyberSync] Downloaded: ${path}`);
                    }
                } else if (meta.status === "deleted") {
                    if (localPaths.has(path)) {
                        // Файл удален на сервере, но есть у нас -> Удаляем
                        const file =
                            this.plugin.app.vault.getAbstractFileByPath(path);
                        if (file) await this.plugin.app.vault.delete(file);
                        new Notice(`[CyberSync] Deleted remote: ${path}`);
                    }
                }
            }
        } catch (e) {
            console.error("Reconcile error:", e);
        } finally {
            this.isProcessingRemote = false;
        }
    }

    // Обработка локальных событий Obsidian
    handleLocalCreate(file: TAbstractFile) {
        if (this.isProcessingRemote || !(file instanceof TFile)) return;

        // Пишем в Yjs
        this.doc.transact(() => {
            this.filesMap.set(file.path, {
                status: "active",
                updated: Date.now(),
            });
        }, "local");
        this.plugin.queueSync("__vault_index__", this.doc);
    }

    handleLocalDelete(file: TAbstractFile) {
        if (this.isProcessingRemote || !(file instanceof TFile)) return;

        this.doc.transact(() => {
            this.filesMap.set(file.path, {
                status: "deleted",
                updated: Date.now(),
            });
        }, "local");
        this.plugin.queueSync("__vault_index__", this.doc);
    }

    handleLocalRename(file: TAbstractFile, oldPath: string) {
        if (this.isProcessingRemote || !(file instanceof TFile)) return;

        this.doc.transact(() => {
            // Старый путь помечаем удаленным
            this.filesMap.set(oldPath, {
                status: "deleted",
                updated: Date.now(),
            });
            // Новый создаем
            this.filesMap.set(file.path, {
                status: "active",
                updated: Date.now(),
            });
        }, "local");
        this.plugin.queueSync("__vault_index__", this.doc);
    }
}

// --- MAIN PLUGIN CLASS ---
export default class SyncPlugin extends Plugin {
    settings: CyberSyncSettings;
    ws: WebSocket | null = null;

    // Док для контента активного файла
    activeContentDoc: Y.Doc | null = null;
    activeFilePath: string | null = null;

    // Менеджер структуры файлов
    vaultManager: VaultSyncManager;

    // Очередь для синхронизации (5 сек)
    // Map<FilePath, Y.Doc>
    docsToSync: Map<string, Y.Doc> = new Map();
    syncIntervalId: number | null = null;
    clientColor: string =
        "#" + Math.floor(Math.random() * 16777215).toString(16);

    async onload() {
        await this.loadSettings();
        if (!this.settings.clientId) {
            this.settings.clientId = Math.random().toString(36).slice(2);
            await this.saveSettings();
        }

        this.addSettingTab(new CyberSyncSettingTab(this.app, this));

        // Инициализация менеджера хранилища
        this.vaultManager = new VaultSyncManager(this);

        // Слушаем события хранилища
        this.registerEvent(
            this.app.vault.on("create", (f) =>
                this.vaultManager.handleLocalCreate(f),
            ),
        );
        this.registerEvent(
            this.app.vault.on("delete", (f) =>
                this.vaultManager.handleLocalDelete(f),
            ),
        );
        this.registerEvent(
            this.app.vault.on("rename", (f, old) =>
                this.vaultManager.handleLocalRename(f, old),
            ),
        );

        // Подключение
        this.connect();

        // Слушаем открытие файлов (контент)
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (leaf) =>
                this.onLeafChange(leaf),
            ),
        );
        this.registerEvent(
            this.app.workspace.on("file-open", (file) => {
                if (!file) this.cleanupContentYjs();
            }),
        );

        // Цикл синхронизации (5 сек)
        this.syncIntervalId = window.setInterval(
            () => this.flushSyncQueue(),
            5000,
        );
    }

    async onunload() {
        this.cleanupContentYjs();
        this.ws?.close();
        if (this.syncIntervalId) clearInterval(this.syncIntervalId);
    }

    // --- CONTENT SYNC (Активный файл) ---
    async onLeafChange(leaf: WorkspaceLeaf | null) {
        if (!leaf || !leaf.view || !(leaf.view instanceof MarkdownView)) return;
        const file = leaf.view.file;
        if (!file) return;

        if (this.activeFilePath !== file.path) {
            await this.cleanupContentYjs();
            await this.initContentYjs(file, leaf.view);
        }
    }

    async initContentYjs(file: TFile, view: MarkdownView) {
        this.activeFilePath = file.path;
        this.activeContentDoc = new Y.Doc();

        const content = await this.app.vault.read(file);
        const yText = this.activeContentDoc.getText("codemirror");

        // Начальная загрузка, если док пуст (на самом деле нужно мержить с базой Yjs)
        if (yText.length === 0) {
            this.activeContentDoc.transact(() => {
                yText.insert(0, content);
            }, "initial");
        }

        // CodeMirror binding
        // @ts-ignore
        const editor = view.editor.cm as EditorView;
        const undoManager = new Y.UndoManager(yText);

        // Подписка на локальные изменения для отправки
        this.activeContentDoc.on("update", (update, origin) => {
            if (origin !== "ws-sync" && this.activeFilePath) {
                this.queueSync(this.activeFilePath, this.activeContentDoc!);
            }
        });

        const extension = yCollab(yText, null, { undoManager });
        const cursorSender = EditorView.updateListener.of((update) => {
            if (update.selectionSet) {
                this.sendCursor(update.state.selection.main.head);
            }
        });

        editor.dispatch({
            effects: StateEffect.appendConfig.of([
                extension,
                cursorField,
                cursorSender,
            ]),
        });

        // Вступаем в комнату контента файла
        this.sendWsMessage({
            type: "join_room",
            filePath: this.activeFilePath,
        });
    }

    async cleanupContentYjs() {
        if (this.activeContentDoc) {
            this.activeContentDoc.destroy();
            this.activeContentDoc = null;
        }
        this.activeFilePath = null;
        // Можно отправить leave_room для файла
    }

    // --- NETWORKING & QUEUE ---

    connect() {
        if (this.ws) this.ws.close();
        const url = `${this.settings.serverUrl}/ws?client_id=${this.settings.clientId}`;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            new Notice("CyberSync Connected");
            // 1. Вступаем в комнату индекса хранилища
            this.sendWsMessage({
                type: "join_room",
                filePath: "__vault_index__",
            });

            // 2. Если файл открыт, вступаем в его комнату
            if (this.activeFilePath) {
                this.sendWsMessage({
                    type: "join_room",
                    filePath: this.activeFilePath,
                });
            }
        };

        this.ws.onmessage = async (event) => {
            const msg = JSON.parse(event.data);
            await this.handleMessage(msg);
        };

        this.ws.onclose = () => {
            new Notice("CyberSync Disconnected");
            setTimeout(() => this.connect(), 5000);
        };
    }

    async handleMessage(msg: any) {
        if (msg.type === "sync_update") {
            const update = fromBase64(msg.update);
            const filePath = msg.filePath;

            if (filePath === "__vault_index__") {
                // Обновление структуры файлов
                Y.applyUpdate(this.vaultManager.doc, update, "ws-sync");
                // Триггерим проверку диска
                this.vaultManager.reconcileVault();
            } else if (
                filePath === this.activeFilePath &&
                this.activeContentDoc
            ) {
                // Обновление контента текущего файла
                Y.applyUpdate(this.activeContentDoc, update, "ws-sync");
            }
        } else if (
            msg.type === "cursor" &&
            msg.filePath === this.activeFilePath
        ) {
            this.updateRemoteCursors(msg);
        }
    }

    // Добавляем документ в очередь на отправку
    queueSync(filePath: string, doc: Y.Doc) {
        this.docsToSync.set(filePath, doc);
    }

    // Срабатывает каждые 5 секунд
    flushSyncQueue() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        this.docsToSync.forEach((doc, filePath) => {
            // Оптимизация: хранить stateVector и слать только diff
            // Для надежности пока шлем полный update состояния
            const update = Y.encodeStateAsUpdate(doc);
            if (update.length > 2) {
                // Фильтр пустых апдейтов
                this.sendWsMessage({
                    type: "sync_update",
                    filePath: filePath,
                    update: toBase64(update),
                });
            }
        });
        this.docsToSync.clear();
    }

    updateRemoteCursors(msg: any) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        // @ts-ignore
        const editor = view.editor.cm as EditorView;
        editor.dispatch({
            effects: cursorEffect.of([
                {
                    clientId: msg.clientId,
                    name: "Remote",
                    color: msg.color,
                    pos: msg.pos,
                },
            ]),
        });
    }

    sendCursor(pos: number) {
        if (this.ws && this.activeFilePath) {
            this.sendWsMessage({
                type: "cursor",
                filePath: this.activeFilePath,
                pos,
                color: this.clientColor,
            });
        }
    }

    sendWsMessage(data: any) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
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
        new Setting(containerEl).setName("Server URL").addText((text) =>
            text
                .setValue(this.plugin.settings.serverUrl)
                .onChange(async (value) => {
                    this.plugin.settings.serverUrl = value;
                    await this.plugin.saveSettings();
                }),
        );
    }
}
