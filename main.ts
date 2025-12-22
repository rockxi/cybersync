import { Plugin, MarkdownView } from 'obsidian';
import { Extension, StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';

// --- ТИПЫ ---
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
    constructor(readonly color: string, readonly label: string) { super(); }
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
    create() { return Decoration.none; },
    update(cursors, tr) {
        cursors = cursors.map(tr.changes);
        for (let e of tr.effects) {
            if (e.is(updateCursorEffect)) {
                const deco = Decoration.widget({
                    widget: new CursorWidget(e.value.color, e.value.clientId),
                    side: 0
                }).range(e.value.pos);
                cursors = cursors.update({
                    filter: (from, to, value) => {
                         // @ts-ignore
                        return value.widget.label !== e.value.clientId; 
                    },
                    add: [deco]
                });
            }
            if (e.is(removeCursorEffect)) {
                 cursors = cursors.update({
                    filter: (from, to, value) => {
                         // @ts-ignore
                        return value.widget.label !== e.value;
                    }
                });
            }
        }
        return cursors;
    },
    provide: (f) => EditorView.decorations.from(f)
});

// --- ПЛАГИН ---
export default class SyncPlugin extends Plugin {
    socket: WebSocket | null = null;
    clientId: string = "User_" + Math.floor(Math.random() * 1000);
    color: string = '#' + Math.floor(Math.random()*16777215).toString(16);

    async onload() {
        // Создаем ViewPlugin внутри onload, чтобы иметь доступ к `this` (экземпляру плагина)
        const socketListener = ViewPlugin.fromClass(class {
            constructor(public view: EditorView) {}
            update(update: ViewUpdate) {
                // Обращаемся к this плагина через замыкание (pluginInstance)
                if (update.selectionSet && pluginInstance.socket?.readyState === WebSocket.OPEN) {
                    const pos = update.state.selection.main.head;
                    pluginInstance.socket.send(JSON.stringify({
                        type: "cursor",
                        pos: pos,
                        color: pluginInstance.color
                    }));
                }
            }
        });

        const pluginInstance = this; // Сохраняем ссылку на плагин

        this.registerEditorExtension([cursorField, socketListener]);

        this.app.workspace.on('file-open', (file) => {
            if (file) this.connectSocket(file.path);
        });
    }

    connectSocket(fileId: string) {
        if (this.socket) this.socket.close();
        const encodedId = encodeURIComponent(fileId);
        // Убедись, что порт совпадает с сервером (8000)
        this.socket = new WebSocket(`ws://localhost:8000/ws/${encodedId}/${this.clientId}`);

        this.socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view) return;

            // Не рисуем свой же курсор, если он прилетел обратно (хотя сервер фильтрует, но на всякий)
            if (data.clientId === this.clientId) return;

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
    }

    onunload() {
        if (this.socket) this.socket.close();
    }
}
