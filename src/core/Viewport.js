/**
 * Viewport — Canvas rendering with pan, zoom, grid, and coordinate transforms.
 */
import { bus } from './EventBus.js';

export default class Viewport {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Camera state
        this.camera = { x: 0, y: 0, zoom: 1 };
        this.minZoom = 0.05;
        this.maxZoom = 20;

        // Interaction state
        this.isPanning = false;
        this.panStart = { x: 0, y: 0 };
        this.mouse = { x: 0, y: 0 };      // screen coords
        this.worldMouse = { x: 0, y: 0 };  // world coords

        // Grid
        this.showGrid = true;
        this.gridSize = 50;

        // Render callbacks
        this._renderCallbacks = [];

        this._init();
    }

    _init() {
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(this.canvas.parentElement);
        this._resize();

        // Mouse events
        this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
        this.canvas.addEventListener('mouseleave', (e) => this._onMouseUp(e));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Start render loop
        this._frameId = requestAnimationFrame(() => this._renderLoop());
    }

    _resize() {
        const parent = this.canvas.parentElement;
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = parent.clientWidth * dpr;
        this.canvas.height = parent.clientHeight * dpr;
        this.width = parent.clientWidth;
        this.height = parent.clientHeight;
        this.dpr = dpr;
        this.render();
    }

    // -------- Coordinate transforms --------

    screenToWorld(sx, sy) {
        return {
            x: (sx - this.width / 2) / this.camera.zoom + this.camera.x,
            y: (sy - this.height / 2) / this.camera.zoom + this.camera.y
        };
    }

    worldToScreen(wx, wy) {
        return {
            x: (wx - this.camera.x) * this.camera.zoom + this.width / 2,
            y: (wy - this.camera.y) * this.camera.zoom + this.height / 2
        };
    }

    // -------- Events --------

    _onWheel(e) {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const newZoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.camera.zoom * zoomFactor));

        // Zoom towards mouse
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const worldBefore = this.screenToWorld(mx, my);

        this.camera.zoom = newZoom;

        const worldAfter = this.screenToWorld(mx, my);
        this.camera.x += worldBefore.x - worldAfter.x;
        this.camera.y += worldBefore.y - worldAfter.y;

        this._updateZoomDisplay();
        this.render();
    }

    _onMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;

        // Middle mouse or space+click = pan
        if (e.button === 1 || (e.button === 0 && this._currentTool === 'pan')) {
            this.isPanning = true;
            this.panStart = { x: sx, y: sy };
            this.panCameraStart = { x: this.camera.x, y: this.camera.y };
            this.canvas.style.cursor = 'grabbing';
            return;
        }

        const world = this.screenToWorld(sx, sy);
        bus.emit('viewport:mousedown', { sx, sy, wx: world.x, wy: world.y, button: e.button, e });
    }

    _onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        this.mouse = { x: sx, y: sy };
        this.worldMouse = this.screenToWorld(sx, sy);

        if (this.isPanning) {
            const dx = (sx - this.panStart.x) / this.camera.zoom;
            const dy = (sy - this.panStart.y) / this.camera.zoom;
            this.camera.x = this.panCameraStart.x - dx;
            this.camera.y = this.panCameraStart.y - dy;
            this.render();
        }

        // Update cursor pos display
        const posEl = document.getElementById('cursor-pos');
        if (posEl) {
            posEl.textContent = `${Math.round(this.worldMouse.x)}, ${Math.round(this.worldMouse.y)}`;
        }

        bus.emit('viewport:mousemove', { sx, sy, wx: this.worldMouse.x, wy: this.worldMouse.y, e });
    }

    _onMouseUp(e) {
        if (this.isPanning) {
            this.isPanning = false;
            this.canvas.style.cursor = '';
            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const world = this.screenToWorld(sx, sy);
        bus.emit('viewport:mouseup', { sx, sy, wx: world.x, wy: world.y, button: e.button, e });
    }

    _updateZoomDisplay() {
        const el = document.getElementById('zoom-level');
        if (el) el.textContent = `${Math.round(this.camera.zoom * 100)}%`;
    }

    setTool(tool) {
        this._currentTool = tool;
        if (tool === 'pan') {
            this.canvas.style.cursor = 'grab';
        } else {
            this.canvas.style.cursor = '';
        }
    }

    zoomToFit(bounds) {
        if (!bounds) return;
        const padFactor = 0.85;
        const zoomX = (this.width * padFactor) / bounds.width;
        const zoomY = (this.height * padFactor) / bounds.height;
        this.camera.zoom = Math.min(zoomX, zoomY, this.maxZoom);
        this.camera.x = bounds.x + bounds.width / 2;
        this.camera.y = bounds.y + bounds.height / 2;
        this._updateZoomDisplay();
        this.render();
    }

    // -------- Rendering --------

    onRender(callback) {
        this._renderCallbacks.push(callback);
    }

    render() {
        this._needsRender = true;
    }

    _renderLoop() {
        if (this._needsRender) {
            this._needsRender = false;
            this._draw();
        }
        this._frameId = requestAnimationFrame(() => this._renderLoop());
    }

    _draw() {
        const ctx = this.ctx;
        const dpr = this.dpr;

        ctx.save();
        ctx.scale(dpr, dpr);

        // Clear
        ctx.fillStyle = '#0d0f12';
        ctx.fillRect(0, 0, this.width, this.height);

        // Apply camera transform
        ctx.save();
        ctx.translate(this.width / 2, this.height / 2);
        ctx.scale(this.camera.zoom, this.camera.zoom);
        ctx.translate(-this.camera.x, -this.camera.y);

        // Draw grid
        if (this.showGrid) this._drawGrid(ctx);

        // Draw origin crosshair
        this._drawOrigin(ctx);

        // Custom render callbacks (images, bones, etc.)
        for (const cb of this._renderCallbacks) {
            cb(ctx, this);
        }

        ctx.restore();
        ctx.restore();
    }

    _drawGrid(ctx) {
        const zoom = this.camera.zoom;
        let gridSize = this.gridSize;

        // Adaptive grid — increase grid size when zoomed out
        while (gridSize * zoom < 20) gridSize *= 5;
        while (gridSize * zoom > 200) gridSize /= 5;

        const left = this.camera.x - this.width / 2 / zoom;
        const right = this.camera.x + this.width / 2 / zoom;
        const top = this.camera.y - this.height / 2 / zoom;
        const bottom = this.camera.y + this.height / 2 / zoom;

        const startX = Math.floor(left / gridSize) * gridSize;
        const startY = Math.floor(top / gridSize) * gridSize;

        ctx.lineWidth = 1 / zoom;

        // Minor grid
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.beginPath();
        for (let x = startX; x <= right; x += gridSize) {
            ctx.moveTo(x, top);
            ctx.lineTo(x, bottom);
        }
        for (let y = startY; y <= bottom; y += gridSize) {
            ctx.moveTo(left, y);
            ctx.lineTo(right, y);
        }
        ctx.stroke();
    }

    _drawOrigin(ctx) {
        const zoom = this.camera.zoom;
        const len = 40 / zoom;
        const lw = 1.5 / zoom;

        // X axis (red)
        ctx.strokeStyle = 'rgba(248, 113, 113, 0.5)';
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(-len, 0);
        ctx.lineTo(len, 0);
        ctx.stroke();

        // Y axis (green)
        ctx.strokeStyle = 'rgba(74, 222, 128, 0.5)';
        ctx.beginPath();
        ctx.moveTo(0, -len);
        ctx.lineTo(0, len);
        ctx.stroke();

        // Center dot
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.beginPath();
        ctx.arc(0, 0, 3 / zoom, 0, Math.PI * 2);
        ctx.fill();
    }

    destroy() {
        cancelAnimationFrame(this._frameId);
        this._resizeObserver.disconnect();
    }
}
