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
        const { boneSystem, imageManager } = this.app;

        if (boneSystem.bones.length === 0) {
            container.innerHTML = '<div class="empty-state">No bones yet. Use the Bone tool (B) to create bones.</div>';
            return;
        }

        // Build a map: boneName → [images bound to it]
        const boneImageMap = {};
        const unboundImages = [];
        for (const img of imageManager.images) {
            if (img.boneName) {
                if (!boneImageMap[img.boneName]) boneImageMap[img.boneName] = [];
                boneImageMap[img.boneName].push(img);
            } else {
                unboundImages.push(img);
            }
        }

        let html = '';
        const renderBone = (bone, depth) => {
            const isSelected = bone === boneSystem.selectedBone;
            const hasChildren = bone.children.length > 0;
            const boundImages = boneImageMap[bone.name] || [];
            const hasContent = hasChildren || boundImages.length > 0;
            const boneColor = bone.color || '#c8d850';
            html += `<div class="tree-item ${isSelected ? 'selected' : ''}" 
                    data-bone-id="${bone.id}" 
                    style="--depth: ${depth}; --bone-item-color: ${boneColor}; border-left: 3px solid ${isSelected ? boneColor : 'transparent'};">
        <span class="tree-toggle ${hasContent ? '' : 'invisible'}">▼</span>
        <span class="bone-dot" style="background: ${boneColor};"></span>
        <span class="tree-label" style="color: ${isSelected ? boneColor : ''};">${bone.name}</span>
        ${boundImages.length > 0 ? `<span class="bone-img-count">${boundImages.length}🖼</span>` : ''}
      </div>`;

            // Render images bound to this bone
            for (const img of boundImages) {
                const isImgSelected = img === imageManager.selectedImage;
                html += `<div class="tree-item tree-image-item ${isImgSelected ? 'selected' : ''}" 
                        data-image-id="${img.id}" draggable="true"
                        style="--depth: ${depth + 1}; border-left: 3px solid ${isImgSelected ? '#4f9cf7' : 'transparent'};">
            <span class="tree-toggle invisible"></span>
            <span class="tree-img-icon">🖼</span>
            <span class="tree-label" style="color: ${isImgSelected ? '#4f9cf7' : 'var(--text-muted)'}; font-size: var(--font-size-xs);">${img.name}</span>
          </div>`;
            }

            for (const child of bone.children) {
                renderBone(child, depth + 1);
            }
        };

        for (const root of boneSystem.rootBones) {
            renderBone(root, 0);
        }

        // Show unbound images at end
        if (unboundImages.length > 0) {
            html += `<div class="tree-item tree-unbound-zone" data-drop-zone="unbound" style="--depth: 0;">
        <span class="tree-toggle invisible"></span>
        <span class="tree-label" style="font-style:italic; color:var(--text-muted);">Unbound Images</span>
      </div>`;
            for (const img of unboundImages) {
                const isImgSelected = img === imageManager.selectedImage;
                html += `<div class="tree-item tree-image-item ${isImgSelected ? 'selected' : ''}" 
                        data-image-id="${img.id}" draggable="true"
                        style="--depth: 1; border-left: 3px solid ${isImgSelected ? '#4f9cf7' : 'transparent'};">
            <span class="tree-toggle invisible"></span>
            <span class="tree-img-icon">🖼</span>
            <span class="tree-label" style="color: ${isImgSelected ? '#4f9cf7' : 'var(--text-muted)'}; font-size: var(--font-size-xs);">${img.name}</span>
          </div>`;
            }
        }

        container.innerHTML = html;

        // Click handlers for bones
        container.querySelectorAll('.tree-item[data-bone-id]').forEach(el => {
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

        // Click handlers for images in the tree
        container.querySelectorAll('.tree-image-item[data-image-id]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = parseInt(el.dataset.imageId);
                const img = imageManager.images.find(i => i.id === id);
                if (img) {
                    imageManager.selectImage(img);
                    this.updateProperties();
                }
                this.app.viewport.render();
            });
        });

        // Set up drag-and-drop for image reparenting
        this._setupBoneTreeDragDrop(container);
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
            const thumbSrc = img.img.src || (img.img.toDataURL ? img.img.toDataURL('image/png') : '');
            html += `<div class="layer-item ${isSelected ? 'selected' : ''}" data-image-id="${img.id}">
        <img class="layer-thumb" src="${thumbSrc}" alt="${img.name}" />
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
            // Build bone options for dropdown
            const boneOptions = this.app.boneSystem.bones.map(b =>
                `<option value="${b.name}" ${image.boneName === b.name ? 'selected' : ''}>${b.name}</option>`
            ).join('');
            const hasBones = this.app.boneSystem.bones.length > 0;

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
            <span class="prop-label">Rotation</span>
            <input class="prop-input" id="prop-img-rotation" type="number" step="0.5" value="${(image.rotation || 0).toFixed(1)}" />
          </div>
          <div class="prop-row">
            <span class="prop-label">Opacity</span>
            <input class="prop-input" id="prop-img-opacity" type="number" step="0.05" min="0" max="1" value="${image.opacity}" />
          </div>
          ${hasBones ? `
          <div class="prop-row" style="margin-top:8px">
            <span class="prop-label">Bone</span>
            <select class="prop-input" id="prop-img-bone" style="cursor:pointer">
              <option value="" ${!image.boneName ? 'selected' : ''}>(none — all bones)</option>
              ${boneOptions}
            </select>
          </div>
          <div class="prop-row" style="justify-content:flex-end;margin-top:4px">
            <button class="btn btn-sm" id="prop-img-recalc-weights" title="Recalculate mesh weights for this image">
              🔄 Recalculate Weights
            </button>
          </div>
          ` : ''}
          <div class="prop-row" style="justify-content:flex-end;margin-top:8px">
            <button class="btn btn-sm" id="prop-img-trim" title="Trim transparent area — crop to visible content">
              ✂ Trim to Content
            </button>
            <button class="btn btn-sm" id="prop-img-trim-all" title="Trim all images to visible content" style="margin-left:4px">
              ✂ Trim All
            </button>
          </div>
        </div>`;

            this._bindPropNumber('prop-img-x', (v) => { image.x = v; this.app.viewport.render(); });
            this._bindPropNumber('prop-img-y', (v) => { image.y = v; this.app.viewport.render(); });
            this._bindPropNumber('prop-img-sx', (v) => { image.scaleX = v; this.app.viewport.render(); });
            this._bindPropNumber('prop-img-sy', (v) => { image.scaleY = v; this.app.viewport.render(); });
            this._bindPropNumber('prop-img-rotation', (v) => { image.rotation = v; this.app.viewport.render(); });
            this._bindPropNumber('prop-img-opacity', (v) => { image.opacity = v; this.app.viewport.render(); });

            // Bone assignment handler
            const boneSelect = document.getElementById('prop-img-bone');
            if (boneSelect) {
                boneSelect.addEventListener('change', () => {
                    const boneName = boneSelect.value || null;
                    image.boneName = boneName;
                    // Recalculate weights with bone filter
                    this._recalcImageWeights(image);
                    this.app.viewport.render();
                    this.updateSlotsList();
                });
            }

            // Recalculate weights button
            const recalcBtn = document.getElementById('prop-img-recalc-weights');
            if (recalcBtn) {
                recalcBtn.addEventListener('click', () => {
                    this._recalcImageWeights(image);
                    this.app.viewport.render();
                    this.showToast('Weights recalculated', 'success');
                });
            }

            // Trim button — crop this image to visible content
            const trimBtn = document.getElementById('prop-img-trim');
            if (trimBtn) {
                trimBtn.addEventListener('click', () => {
                    const trimmed = this.app.imageManager.trimToContent(image);
                    if (trimmed) {
                        this.updateProperties();
                        this.app.viewport.render();
                        this.showToast(`Trimmed "${image.name}" to ${image.width}×${image.height}`, 'success');
                    } else {
                        this.showToast('Image already tight — nothing to trim', 'info');
                    }
                });
            }

            // Trim All button
            const trimAllBtn = document.getElementById('prop-img-trim-all');
            if (trimAllBtn) {
                trimAllBtn.addEventListener('click', () => {
                    const count = this.app.imageManager.trimAllToContent();
                    this.updateProperties();
                    this.updateLayerList();
                    this.app.viewport.render();
                    this.showToast(`Trimmed ${count} images to content`, 'success');
                });
            }

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

    _recalcImageWeights(image) {
        const { meshSystem } = this.app;
        let mesh = meshSystem.meshes.get(image.id);
        if (!mesh) {
            mesh = meshSystem.generateMesh(image, 5, 8);
        }
        // Get allowed bone names (assigned bone + descendants), or null for all
        const allowedBones = image.boneName
            ? this._getBoneAndDescendants(image.boneName)
            : null;
        meshSystem.autoComputeWeights(mesh, image, 4, allowedBones);
    }

    _getBoneAndDescendants(boneName) {
        const bone = this.app.boneSystem.getBoneByName(boneName);
        if (!bone) return null;
        const result = [];
        const collect = (b) => {
            result.push(b.name);
            for (const child of b.children) collect(child);
        };
        collect(bone);
        return result;
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

    // -------- Bone Tree Drag & Drop (Image Reparenting) --------

    _setupBoneTreeDragDrop(container) {
        const { imageManager, boneSystem } = this.app;

        // --- dragstart on image items ---
        container.querySelectorAll('.tree-image-item[draggable]').forEach(el => {
            el.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', el.dataset.imageId);
                el.classList.add('dragging');
            });
            el.addEventListener('dragend', () => {
                el.classList.remove('dragging');
                // Clean up all drag-over highlights
                container.querySelectorAll('.drag-over').forEach(d => d.classList.remove('drag-over'));
            });
        });

        // --- dragover / dragenter / dragleave / drop on bone items ---
        const dropTargets = container.querySelectorAll('.tree-item[data-bone-id], .tree-item[data-drop-zone="unbound"]');
        dropTargets.forEach(target => {
            target.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            target.addEventListener('dragenter', (e) => {
                e.preventDefault();
                target.classList.add('drag-over');
            });
            target.addEventListener('dragleave', (e) => {
                // Only remove if actually leaving the target (not entering a child)
                if (!target.contains(e.relatedTarget)) {
                    target.classList.remove('drag-over');
                }
            });
            target.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                target.classList.remove('drag-over');

                const imageId = parseInt(e.dataTransfer.getData('text/plain'));
                if (isNaN(imageId)) return;

                const img = imageManager.images.find(i => i.id === imageId);
                if (!img) return;

                // Determine target bone name
                let newBoneName = null;
                if (target.dataset.boneId) {
                    const boneId = parseInt(target.dataset.boneId);
                    const bone = boneSystem.bones.find(b => b.id === boneId);
                    if (bone) newBoneName = bone.name;
                }
                // data-drop-zone="unbound" → newBoneName stays null

                // Skip if same assignment
                if (img.boneName === newBoneName) return;

                const oldBone = img.boneName || '(unbound)';
                img.boneName = newBoneName;

                // Recalculate mesh weights for new bone assignment
                this._recalcImageWeights(img);

                // Refresh UI
                this.updateBoneTree();
                this.updateSlotsList();
                this.updateProperties();
                this.app.viewport.render();

                const targetLabel = newBoneName || 'Unbound';
                this.showToast(`Moved "${img.name}" → ${targetLabel}`, 'success');
            });
        });
    }

    // -------- Drag & Drop (File Import) --------

    _setupDragDrop() {
        let overlay = document.createElement('div');
        overlay.className = 'drop-overlay';
        overlay.innerHTML = '<span class="drop-overlay-text">Drop images here to import</span>';
        document.body.appendChild(overlay);

        let dragCounter = 0;

        document.addEventListener('dragenter', (e) => {
            e.preventDefault();
            // Only show overlay for external file drops, not internal tree drags
            if (!e.dataTransfer.types.includes('Files')) return;
            dragCounter++;
            overlay.classList.add('active');
        });

        document.addEventListener('dragleave', (e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
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
