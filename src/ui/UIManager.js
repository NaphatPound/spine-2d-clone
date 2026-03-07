/**
 * UIManager — Handles all UI panel updates: bone tree, layer list, 
 * properties panel, slots list, toolbar state, toasts, and drag-drop.
 */
import { bus } from '../core/EventBus.js';

export default class UIManager {
    constructor(app) {
        this.app = app;
        this._init();
    }

    _init() {
        // Subscribe to events
        bus.on('bones:changed', () => this.updateBoneTree());
        bus.on('bones:selected', () => {
            this.updateBoneTree();
            this.updateProperties();
        });
        bus.on('images:changed', () => this.updateLayerList());
        bus.on('images:selected', () => {
            this.updateLayerList();
            this.updateProperties();
        });
        bus.on('slots:changed', () => this.updateSlotsList());

        // Drag and drop
        this._setupDragDrop();
    }

    // -------- Bone Tree --------

    updateBoneTree() {
        const container = document.getElementById('bone-tree');
        const { boneSystem } = this.app;

        if (boneSystem.bones.length === 0) {
            container.innerHTML = '<div class="empty-state">No bones yet. Use the Bone tool (B) to create bones.</div>';
            return;
        }

        let html = '';
        const renderBone = (bone, depth) => {
            const isSelected = bone === boneSystem.selectedBone;
            const hasChildren = bone.children.length > 0;
            const boneColor = bone.color || '#c8d850';
            html += `<div class="tree-item ${isSelected ? 'selected' : ''}" 
                    data-bone-id="${bone.id}" 
                    style="--depth: ${depth}; --bone-item-color: ${boneColor}; border-left: 3px solid ${isSelected ? boneColor : 'transparent'};">
        <span class="tree-toggle ${hasChildren ? '' : 'invisible'}">▼</span>
        <span class="bone-dot" style="background: ${boneColor};"></span>
        <span class="tree-label" style="color: ${isSelected ? boneColor : ''};">${bone.name}</span>
      </div>`;
            for (const child of bone.children) {
                renderBone(child, depth + 1);
            }
        };

        for (const root of boneSystem.rootBones) {
            renderBone(root, 0);
        }

        container.innerHTML = html;

        // Click handlers
        container.querySelectorAll('.tree-item').forEach(el => {
            el.addEventListener('click', () => {
                const id = parseInt(el.dataset.boneId);
                const bone = boneSystem.bones.find(b => b.id === id);
                if (bone) boneSystem.selectBone(bone);
                this.app.viewport.render();
            });

            // Right-click context menu
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const id = parseInt(el.dataset.boneId);
                const bone = boneSystem.bones.find(b => b.id === id);
                if (bone) {
                    boneSystem.selectBone(bone);
                    this._showBoneContextMenu(e.clientX, e.clientY, bone);
                }
            });
        });
    }

    _showBoneContextMenu(x, y, bone) {
        this._removeContextMenu();

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        const items = [
            {
                label: 'Add Child Bone', action: () => {
                    const child = this.app.boneSystem.addBone(null, bone, { length: 50 });
                    this.app.boneSystem.selectBone(child);
                    this.app.viewport.render();
                }
            },
            { label: 'Rename', action: () => this._promptRenameBone(bone) },
            { separator: true },
            {
                label: 'Delete Bone', action: () => {
                    this.app.boneSystem.removeBone(bone);
                    this.app.viewport.render();
                }, danger: true
            }
        ];

        for (const item of items) {
            if (item.separator) {
                menu.innerHTML += '<div class="context-menu-separator"></div>';
                continue;
            }
            const div = document.createElement('div');
            div.className = 'context-menu-item';
            if (item.danger) div.style.color = 'var(--danger)';
            div.textContent = item.label;
            div.addEventListener('click', () => {
                item.action();
                this._removeContextMenu();
            });
            menu.appendChild(div);
        }

        document.body.appendChild(menu);

        // Close on click outside
        setTimeout(() => {
            const close = (e) => {
                if (!menu.contains(e.target)) {
                    this._removeContextMenu();
                    document.removeEventListener('mousedown', close);
                }
            };
            document.addEventListener('mousedown', close);
        }, 10);
    }

    _removeContextMenu() {
        document.querySelectorAll('.context-menu').forEach(m => m.remove());
    }

    _promptRenameBone(bone) {
        const name = prompt('Rename bone:', bone.name);
        if (name && name.trim()) {
            this.app.boneSystem.renameBone(bone, name.trim());
            this.app.viewport.render();
        }
    }

    // -------- Layer List --------

    updateLayerList() {
        const container = document.getElementById('layer-list');
        const { imageManager } = this.app;

        if (imageManager.images.length === 0) {
            container.innerHTML = '<div class="empty-state">No images. Click + or drag & drop files.</div>';
            return;
        }

        let html = '';
        for (const img of imageManager.images) {
            const isSelected = img === imageManager.selectedImage;
            html += `<div class="layer-item ${isSelected ? 'selected' : ''}" data-image-id="${img.id}">
        <img class="layer-thumb" src="${img.img.src}" alt="${img.name}" />
        <span class="layer-name">${img.name}</span>
        <button class="layer-visibility ${img.visible ? '' : 'hidden'}" 
                data-image-id="${img.id}" title="Toggle Visibility">
          ${img.visible ? '👁' : '👁‍🗨'}
        </button>
      </div>`;
        }

        container.innerHTML = html;

        // Click handlers
        container.querySelectorAll('.layer-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.layer-visibility')) return;
                const id = parseInt(el.dataset.imageId);
                const img = imageManager.images.find(i => i.id === id);
                if (img) imageManager.selectImage(img);
                this.app.viewport.render();
            });
        });

        container.querySelectorAll('.layer-visibility').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.imageId);
                const img = imageManager.images.find(i => i.id === id);
                if (img) {
                    imageManager.toggleVisibility(img);
                    this.app.viewport.render();
                }
            });
        });
    }

    // -------- Properties Panel --------

    updateProperties() {
        const container = document.getElementById('properties-panel');
        const { boneSystem, imageManager } = this.app;

        const bone = boneSystem.selectedBone;
        const image = imageManager.selectedImage;

        if (bone) {
            container.innerHTML = `
        <div class="prop-group">
          <div class="prop-group-title">Bone: ${bone.name}</div>
          <div class="prop-row">
            <span class="prop-label">Name</span>
            <input class="prop-input" id="prop-bone-name" value="${bone.name}" />
          </div>
          <div class="prop-row">
            <span class="prop-label">Position</span>
            <div class="prop-input-pair">
              <span class="prop-input-label x">X</span>
              <input class="prop-input" id="prop-bone-x" type="number" step="0.1" value="${bone.x.toFixed(1)}" />
              <span class="prop-input-label y">Y</span>
              <input class="prop-input" id="prop-bone-y" type="number" step="0.1" value="${bone.y.toFixed(1)}" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rotation</span>
            <input class="prop-input" id="prop-bone-rotation" type="number" step="0.1" value="${bone.rotation.toFixed(1)}" />
          </div>
          <div class="prop-row">
            <span class="prop-label">Length</span>
            <input class="prop-input" id="prop-bone-length" type="number" step="1" value="${bone.length.toFixed(1)}" />
          </div>
          <div class="prop-row">
            <span class="prop-label">Scale</span>
            <div class="prop-input-pair">
              <span class="prop-input-label x">X</span>
              <input class="prop-input" id="prop-bone-scalex" type="number" step="0.01" value="${bone.scaleX}" />
              <span class="prop-input-label y">Y</span>
              <input class="prop-input" id="prop-bone-scaley" type="number" step="0.01" value="${bone.scaleY}" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Parent</span>
            <span class="prop-input" style="border:none;background:none;color:var(--text-muted)">${bone.parent ? bone.parent.name : '(none)'}</span>
          </div>
          <div class="prop-row" style="margin-top:8px">
            <span class="prop-label">World</span>
            <span style="font-family:var(--font-mono);font-size:var(--font-size-xs);color:var(--text-muted)">
              ${bone.worldX.toFixed(1)}, ${bone.worldY.toFixed(1)} @ ${bone.worldRotation.toFixed(1)}°
            </span>
          </div>
        </div>`;

            // Input change handlers
            this._bindPropInput('prop-bone-name', (v) => {
                this.app.boneSystem.renameBone(bone, v);
                this.updateBoneTree();
            });
            this._bindPropNumber('prop-bone-x', (v) => { bone.x = v; this._refreshBones(); });
            this._bindPropNumber('prop-bone-y', (v) => { bone.y = v; this._refreshBones(); });
            this._bindPropNumber('prop-bone-rotation', (v) => { bone.rotation = v; this._refreshBones(); });
            this._bindPropNumber('prop-bone-length', (v) => { bone.length = v; this._refreshBones(); });
            this._bindPropNumber('prop-bone-scalex', (v) => { bone.scaleX = v; this._refreshBones(); });
            this._bindPropNumber('prop-bone-scaley', (v) => { bone.scaleY = v; this._refreshBones(); });

        } else if (image) {
            container.innerHTML = `
        <div class="prop-group">
          <div class="prop-group-title">Image: ${image.name}</div>
          <div class="prop-row">
            <span class="prop-label">Size</span>
            <span style="font-family:var(--font-mono);font-size:var(--font-size-sm);color:var(--text-muted)">
              ${image.width} × ${image.height}
            </span>
          </div>
          <div class="prop-row">
            <span class="prop-label">Position</span>
            <div class="prop-input-pair">
              <span class="prop-input-label x">X</span>
              <input class="prop-input" id="prop-img-x" type="number" step="1" value="${image.x.toFixed(0)}" />
              <span class="prop-input-label y">Y</span>
              <input class="prop-input" id="prop-img-y" type="number" step="1" value="${image.y.toFixed(0)}" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Scale</span>
            <div class="prop-input-pair">
              <span class="prop-input-label x">X</span>
              <input class="prop-input" id="prop-img-sx" type="number" step="0.01" value="${image.scaleX}" />
              <span class="prop-input-label y">Y</span>
              <input class="prop-input" id="prop-img-sy" type="number" step="0.01" value="${image.scaleY}" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Opacity</span>
            <input class="prop-input" id="prop-img-opacity" type="number" step="0.05" min="0" max="1" value="${image.opacity}" />
          </div>
        </div>`;

            this._bindPropNumber('prop-img-x', (v) => { image.x = v; this.app.viewport.render(); });
            this._bindPropNumber('prop-img-y', (v) => { image.y = v; this.app.viewport.render(); });
            this._bindPropNumber('prop-img-sx', (v) => { image.scaleX = v; this.app.viewport.render(); });
            this._bindPropNumber('prop-img-sy', (v) => { image.scaleY = v; this.app.viewport.render(); });
            this._bindPropNumber('prop-img-opacity', (v) => { image.opacity = v; this.app.viewport.render(); });

        } else {
            container.innerHTML = '<div class="empty-state">Select a bone or image to view properties.</div>';
        }
    }

    _bindPropInput(id, callback) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => callback(el.value));
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
    }

    _bindPropNumber(id, callback) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => callback(parseFloat(el.value) || 0));
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
    }

    _refreshBones() {
        this.app.boneSystem.updateWorldTransforms();
        this.app.viewport.render();
        bus.emit('bones:changed');
    }

    // -------- Slots List --------

    updateSlotsList() {
        const container = document.getElementById('slots-list');
        const { slotSystem } = this.app;

        if (slotSystem.slots.length === 0) {
            container.innerHTML = '<div class="empty-state">No slots. Create bones and attach images.</div>';
            return;
        }

        let html = '';
        for (const slot of slotSystem.slots) {
            const isSelected = slot === slotSystem.selectedSlot;
            html += `<div class="slot-item ${isSelected ? 'selected' : ''}" data-slot-id="${slot.id}">
        <span class="slot-color-swatch" style="background: #${slot.color.substring(0, 6)}"></span>
        <span>${slot.name}</span>
        <span style="margin-left:auto;color:var(--text-muted);font-size:10px">→ ${slot.bone}</span>
      </div>`;
        }

        container.innerHTML = html;

        container.querySelectorAll('.slot-item').forEach(el => {
            el.addEventListener('click', () => {
                const id = parseInt(el.dataset.slotId);
                const slot = slotSystem.slots.find(s => s.id === id);
                if (slot) slotSystem.selectSlot(slot);
            });
        });
    }

    // -------- Drag & Drop --------

    _setupDragDrop() {
        let overlay = document.createElement('div');
        overlay.className = 'drop-overlay';
        overlay.innerHTML = '<span class="drop-overlay-text">Drop images here to import</span>';
        document.body.appendChild(overlay);

        let dragCounter = 0;

        document.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            overlay.classList.add('active');
        });

        document.addEventListener('dragleave', (e) => {
            dragCounter--;
            if (dragCounter === 0) overlay.classList.remove('active');
        });

        document.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        document.addEventListener('drop', async (e) => {
            e.preventDefault();
            dragCounter = 0;
            overlay.classList.remove('active');

            const files = [...e.dataTransfer.files].filter(f =>
                f.type.startsWith('image/') || f.name.endsWith('.psd')
            );

            if (files.length > 0) {
                await this.app.importFiles(files);
            }
        });
    }

    // -------- Toast Notifications --------

    showToast(message, type = 'info', duration = 2500) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // -------- Status --------

    setStatus(message) {
        const el = document.getElementById('status-message');
        if (el) el.textContent = message;
    }

    setStatusInfo(info) {
        const el = document.getElementById('status-info');
        if (el) el.textContent = info;
    }
}
