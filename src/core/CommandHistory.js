/**
 * CommandHistory — Undo/Redo stack for all editor operations.
 * Each command is an object with { execute(), undo(), description }.
 */
import { bus } from './EventBus.js';

export default class CommandHistory {
    constructor(maxSize = 100) {
        this.undoStack = [];
        this.redoStack = [];
        this.maxSize = maxSize;
    }

    /**
     * Execute a command and push it to the undo stack.
     * @param {{ execute: Function, undo: Function, description?: string }} command
     */
    execute(command) {
        command.execute();
        this.undoStack.push(command);
        if (this.undoStack.length > this.maxSize) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        bus.emit('history:changed');
    }

    /**
     * Push a command without executing it (for operations already performed).
     */
    push(command) {
        this.undoStack.push(command);
        if (this.undoStack.length > this.maxSize) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        bus.emit('history:changed');
    }

    undo() {
        if (this.undoStack.length === 0) return false;
        const command = this.undoStack.pop();
        command.undo();
        this.redoStack.push(command);
        bus.emit('history:changed');
        return true;
    }

    redo() {
        if (this.redoStack.length === 0) return false;
        const command = this.redoStack.pop();
        command.execute();
        this.undoStack.push(command);
        bus.emit('history:changed');
        return true;
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    clear() {
        this.undoStack = [];
        this.redoStack = [];
        bus.emit('history:changed');
    }
}
