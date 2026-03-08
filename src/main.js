/**
 * Spine 2D Clone — Main Application Entry Point
 * Wires together all modules: Viewport, BoneSystem, ImageManager, SlotSystem, SpineExporter, UIManager.
 */
import Viewport from './core/Viewport.js';
import BoneSystem from './core/BoneSystem.js';
import ImageManager from './core/ImageManager.js';
import SlotSystem from './core/SlotSystem.js';
import CommandHistory from './core/CommandHistory.js';
import AnimationSystem from './core/AnimationSystem.js';
import AutoRigger from './core/AutoRigger.js';
import MeshSystem from './core/MeshSystem.js';
import SpineExporter from './export/SpineExporter.js';
import UIManager from './ui/UIManager.js';
import Timeline from './ui/Timeline.js';
import { importPsd } from './core/PsdImporter.js';
import { bus } from './core/EventBus.js';

class App {
    constructor() {
        // Core systems
        this.boneSystem = new BoneSystem();
        this.imageManager = new ImageManager();
        this.slotSystem = new SlotSystem(this.boneSystem, this.imageManager);

        // Viewport
        const canvas = document.getElementById('viewport-canvas');
        this.viewport = new Viewport(canvas);

        // Animation
        this.animSystem = new AnimationSystem(this.boneSystem);

        // Auto Rigger
        this.autoRigger = new AutoRigger(this.boneSystem);

        // Mesh System
        this.meshSystem = new MeshSystem(this.boneSystem);

        // Exporter (needs animSystem)
        this.exporter = new SpineExporter(this.boneSystem, this.slotSystem, this.imageManager, this.animSystem);

        // UI
        this.ui = new UIManager(this);

        // Timeline (needs DOM to be ready, after UI)
        this.timeline = new Timeline(this.animSystem, this.boneSystem);

        // Current tool
        this.currentTool = 'select';

        // Undo/Redo
        this.history = new CommandHistory();

        // Bone drag state
        this._draggingBone = null;
        this._draggingImage = null;
        this._dragOffset = { x: 0, y: 0 };

        // Rotation state
        this._rotatingBone = null;
        this._rotateStartAngle = 0;
        this._rotateStartRotation = 0;

        // Mesh edit state
        this._meshEditMode = false;
        this._meshSubMode = 'select'; // 'select' or 'paint'
        this._meshActiveBone = null;
        this._meshBrushRadius = 40;
        this._meshBrushStrength = 30;
        this._meshPainting = false;
        this._meshBrushWorldPos = null; // for rendering brush circle
        this._draggingVertex = false;
        this._dragVertexIdx = -1;
        this._dragVertexStart = null;

        this._setupRenderPipeline();
        this._setupToolbar();
        this._setupViewportInteractions();
        this._setupKeyboard();
        this._setupFileButtons();

        this.ui.setStatus('Ready — Use the Bone tool (B) to start rigging');
        this.ui.setStatusInfo(`Bones: 0 | Images: 0`);

        // Update status info on changes
        bus.on('bones:changed', () => this._updateStatusInfo());
        bus.on('images:changed', () => this._updateStatusInfo());

        // Toast events from timeline
        bus.on('toast', (data) => this.ui.showToast(data.message, data.type));

        // When animation time changes (scrub, playback), re-render viewport
        bus.on('animation:timechange', () => this.viewport.render());
        // When play starts, kick off continuous rendering
        bus.on('animation:play', () => this.viewport.render());
    }

    // -------- Render Pipeline --------

    _setupRenderPipeline() {
        // Images are rendered first (bottom layer)
        this.viewport.onRender((ctx, vp) => {
            this.imageManager.render(ctx, vp, this.boneSystem, this.meshSystem);
        });

        // Auto-rig preview overlay (above images, below bones)
        this.viewport.onRender((ctx, vp) => {
            this.autoRigger.renderPreview(ctx, vp);
        });

        // Mesh weight preview overlay
        this.viewport.onRender((ctx, vp) => {
            if (this.meshSystem.weightPreviewActive) {
                const img = this.imageManager.images.find(i => i.id === this.meshSystem.selectedMeshId);
                if (img) this.meshSystem.renderWeightPreview(ctx, vp, img);
            }

            // Brush circle for paint mode
            if (this._meshEditMode && this._meshSubMode === 'paint' && this._meshBrushWorldPos) {
                const zoom = vp.camera.zoom;
                ctx.save();
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
                ctx.lineWidth = 1.5 / zoom;
                ctx.setLineDash([4 / zoom, 3 / zoom]);
                ctx.beginPath();
                ctx.arc(this._meshBrushWorldPos.x, this._meshBrushWorldPos.y, this._meshBrushRadius, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
                ctx.beginPath();
                ctx.arc(this._meshBrushWorldPos.x, this._meshBrushWorldPos.y, 2 / zoom, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        });

        // Bones rendered on top
        this.viewport.onRender((ctx, vp) => {
            // Tick animation system
            this.animSystem.tick();
            this.boneSystem.render(ctx, vp);
            // Keep rendering while animation is playing
            if (this.animSystem.playing) {
                this.viewport.render();
            }
        });

        this.viewport.render();
    }

    // -------- Tool Selection --------

    _setupToolbar() {
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.setTool(btn.dataset.tool);
            });
        });

        // Zoom to fit
        document.getElementById('btn-zoom-fit')?.addEventListener('click', () => {
            const bounds = this.imageManager.getBounds(this.boneSystem);
            if (bounds) {
                this.viewport.zoomToFit(bounds);
            } else {
                this.viewport.camera = { x: 0, y: 0, zoom: 1 };
                this.viewport.render();
            }
        });

        // Auto Rig — start preview
        document.getElementById('btn-auto-rig')?.addEventListener('click', () => {
            this._startAutoRigPreview();
        });

        // Preview bar buttons
        document.getElementById('arb-apply')?.addEventListener('click', () => {
            this._applyAutoRig();
        });
        document.getElementById('arb-cancel')?.addEventListener('click', () => {
            this._cancelAutoRig();
        });

        // Mesh Edit button
        document.getElementById('btn-mesh-edit')?.addEventListener('click', () => {
            if (this._meshEditMode) {
                this._leaveMeshEditMode();
            } else {
                this._enterMeshEditMode();
            }
        });

        // Weight preview bar buttons
        document.getElementById('wpb-apply')?.addEventListener('click', () => {
            this._applyWeights();
        });
        document.getElementById('wpb-cancel')?.addEventListener('click', () => {
            this._cancelWeights();
        });

        // Mode toggle buttons
        document.getElementById('mesh-mode-select')?.addEventListener('click', () => {
            this._setMeshSubMode('select');
        });
        document.getElementById('mesh-mode-paint')?.addEventListener('click', () => {
            this._setMeshSubMode('paint');
        });

        // Brush size slider
        document.getElementById('mesh-brush-size')?.addEventListener('input', (e) => {
            this._meshBrushRadius = parseInt(e.target.value);
            document.getElementById('mesh-brush-size-val').textContent = e.target.value;
        });
        // Brush strength slider
        document.getElementById('mesh-brush-strength')?.addEventListener('input', (e) => {
            this._meshBrushStrength = parseInt(e.target.value);
            document.getElementById('mesh-brush-strength-val').textContent = e.target.value;
        });
        // Active bone selector
        document.getElementById('mesh-active-bone')?.addEventListener('change', (e) => {
            this._meshActiveBone = e.target.value;
        });

        // Mesh resolution controls
        const regenerateMeshes = () => {
            const cols = parseInt(document.getElementById('mesh-cols')?.value || '5');
            const rows = parseInt(document.getElementById('mesh-rows')?.value || '8');
            for (const img of this.imageManager.images) {
                this.meshSystem.removeMesh(img.id);
                const mesh = this.meshSystem.generateMesh(img, cols, rows);
                this.meshSystem.autoComputeWeights(mesh, img);
            }
            if (this.meshSystem.weightPreviewActive) {
                this.meshSystem.selectedVertexIdx = -1;
                document.getElementById('weight-editor-panel').style.display = 'none';
            }
            this.viewport.render();
        };
        document.getElementById('mesh-cols')?.addEventListener('change', regenerateMeshes);
        document.getElementById('mesh-rows')?.addEventListener('change', regenerateMeshes);
    }

    async _startAutoRigPreview() {
        if (this.autoRigger.previewActive) return; // Already in preview

        if (this.imageManager.images.length === 0) {
            this.ui.showToast('Import an image first', 'warning');
            return;
        }

        const btn = document.getElementById('btn-auto-rig');
        btn?.classList.add('loading');

        try {
            const image = this.imageManager.selectedImage || this.imageManager.images[0];
            const found = await this.autoRigger.detectAndPreview(image);

            if (found) {
                // Show the preview bar
                document.getElementById('autorig-preview-bar').style.display = 'flex';
                // Zoom to fit the image
                const bounds = this.imageManager.getBounds(this.boneSystem);
                if (bounds) this.viewport.zoomToFit(bounds);
                this.viewport.render();
            }
        } catch (err) {
            console.error('Auto-rig error:', err);
            this.ui.showToast('Auto-rig failed: ' + err.message, 'error');
        } finally {
            btn?.classList.remove('loading');
        }
    }

    _applyAutoRig() {
        const createdBones = this.autoRigger.applyPreview();
        if (!createdBones) return;

        // Hide auto-rig preview bar
        document.getElementById('autorig-preview-bar').style.display = 'none';

        // Auto-create slots mapping bones to the image
        this.slotSystem.autoCreateSlots(this.boneSystem.bones, this.imageManager.images);

        // Auto-generate mesh and weights for each image
        for (const img of this.imageManager.images) {
            const mesh = this.meshSystem.generateMesh(img, 5, 8);
            this.meshSystem.autoComputeWeights(mesh, img);
        }

        // Capture the current bone positions as the setup (rest) pose
        // This MUST happen after bones are finalized but before user edits
        this.animSystem.captureSetupPose();

        // Show weight preview for the first image
        if (this.imageManager.images.length > 0) {
            const firstImg = this.imageManager.images[0];
            this.meshSystem.startWeightPreview(firstImg.id);
            document.getElementById('weight-preview-bar').style.display = '';
        }

        // Update UI
        this.ui.updateBoneTree();
        this.ui.updateLayerList();
        this.ui.updateProperties();
        this.ui.updateSlotsList();
        this.viewport.render();

        // Zoom to fit
        const bounds = this.imageManager.getBounds(this.boneSystem);
        if (bounds) this.viewport.zoomToFit(bounds);
    }

    _applyWeights() {
        this._leaveMeshEditMode();
        this.ui.showToast('Mesh weights applied', 'success');
    }

    _cancelWeights() {
        // Remove all meshes
        for (const img of this.imageManager.images) {
            this.meshSystem.removeMesh(img.id);
        }
        this._leaveMeshEditMode();
        this.ui.showToast('Mesh removed', 'info');
    }

    _cancelAutoRig() {
        this.autoRigger.cancelPreview();
        document.getElementById('autorig-preview-bar').style.display = 'none';
        this.viewport.render();
        this.ui.showToast('Auto-rig cancelled', 'info');
    }

    // ========== MESH EDIT MODE ==========

    _enterMeshEditMode() {
        if (this.imageManager.images.length === 0) {
            this.ui.showToast('No images to edit mesh', 'warning');
            return;
        }
        if (this.boneSystem.bones.length === 0) {
            this.ui.showToast('Create bones first', 'warning');
            return;
        }

        this._meshEditMode = true;
        document.getElementById('btn-mesh-edit')?.classList.add('active');

        // Generate meshes if they don't exist
        const cols = parseInt(document.getElementById('mesh-cols')?.value || '5');
        const rows = parseInt(document.getElementById('mesh-rows')?.value || '8');
        for (const img of this.imageManager.images) {
            if (!this.meshSystem.getMesh(img.id)) {
                const mesh = this.meshSystem.generateMesh(img, cols, rows);
                this.meshSystem.autoComputeWeights(mesh, img);
            }
        }

        // Start weight preview for the first image
        const firstImg = this.imageManager.images[0];
        this.meshSystem.startWeightPreview(firstImg.id);

        // Show mesh edit bar
        document.getElementById('weight-preview-bar').style.display = 'flex';
        this._populateBoneSelector();
        this._setMeshSubMode('select');
        this.viewport.render();
    }

    _leaveMeshEditMode() {
        this._meshEditMode = false;
        this._meshPainting = false;
        this._draggingVertex = false;
        this._meshBrushWorldPos = null;
        document.getElementById('btn-mesh-edit')?.classList.remove('active');
        this.meshSystem.cancelWeightPreview();
        document.getElementById('weight-preview-bar').style.display = 'none';
        document.getElementById('weight-editor-panel').style.display = 'none';
        this.viewport.render();
    }

    _setMeshSubMode(mode) {
        this._meshSubMode = mode;
        document.getElementById('mesh-mode-select')?.classList.toggle('active', mode === 'select');
        document.getElementById('mesh-mode-paint')?.classList.toggle('active', mode === 'paint');
        document.getElementById('mesh-paint-controls').style.display = mode === 'paint' ? 'flex' : 'none';

        if (mode === 'paint') {
            this.viewport.canvas.style.cursor = 'crosshair';
        } else {
            this.viewport.canvas.style.cursor = 'default';
        }

        // Hide weight editor when switching modes
        if (mode !== 'select') {
            document.getElementById('weight-editor-panel').style.display = 'none';
        }
    }

    _populateBoneSelector() {
        const select = document.getElementById('mesh-active-bone');
        if (!select) return;
        select.innerHTML = '';
        for (const bone of this.boneSystem.bones) {
            const opt = document.createElement('option');
            opt.value = bone.name;
            opt.textContent = bone.name;
            opt.style.color = bone.color || '#c8d850';
            select.appendChild(opt);
        }
        if (this.boneSystem.bones.length > 0) {
            this._meshActiveBone = this.boneSystem.bones[0].name;
        }
    }

    _updateWeightEditor() {
        const panel = document.getElementById('weight-editor-panel');
        const sliders = document.getElementById('wep-sliders');
        const vertexLabel = document.getElementById('wep-vertex-id');

        if (this.meshSystem.selectedVertexIdx < 0 || this.meshSystem.selectedMeshId < 0) {
            panel.style.display = 'none';
            return;
        }

        const mesh = this.meshSystem.getMesh(this.meshSystem.selectedMeshId);
        if (!mesh) return;

        panel.style.display = '';
        vertexLabel.textContent = `#${this.meshSystem.selectedVertexIdx}`;

        const weights = mesh.weights[this.meshSystem.selectedVertexIdx] || {};

        // Build slider rows for all bones
        let html = '';
        for (const bone of this.boneSystem.bones) {
            const w = weights[bone.name] || 0;
            const color = bone.color || '#c8d850';
            html += `<div class="wep-slider-row">
                <span class="wep-bone-dot" style="background:${color}"></span>
                <span class="wep-bone-name">${bone.name}</span>
                <input type="range" class="wep-slider" min="0" max="100" step="1"
                       value="${Math.round(w * 100)}"
                       data-bone="${bone.name}"
                       style="accent-color:${color}">
                <span class="wep-weight-value">${(w * 100).toFixed(0)}%</span>
            </div>`;
        }
        sliders.innerHTML = html;

        // Attach slider event handlers
        sliders.querySelectorAll('.wep-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const boneName = e.target.dataset.bone;
                const newWeight = parseInt(e.target.value) / 100;
                this.meshSystem.setVertexWeight(
                    this.meshSystem.selectedMeshId,
                    this.meshSystem.selectedVertexIdx,
                    boneName, newWeight
                );
                // Update display
                e.target.parentElement.querySelector('.wep-weight-value').textContent =
                    `${e.target.value}%`;
                this.viewport.render();
            });
        });
    }

    setTool(tool) {
        this.currentTool = tool;
        this.viewport.setTool(tool);

        // Update toolbar UI
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });

        // Cancel any ongoing bone creation
        if (tool !== 'bone') {
            this.boneSystem.cancelBoneCreation();
        }

        const toolNames = { select: 'Select', bone: 'Create Bone', move: 'Move', rotate: 'Rotate', pan: 'Pan' };
        this.ui.setStatus(`Tool: ${toolNames[tool] || tool}`);
    }

    // -------- Viewport Interactions --------

    _setupViewportInteractions() {
        bus.on('viewport:mousedown', (data) => {
            const { wx, wy, button } = data;
            if (button !== 0) return; // left click only

            // --- Weight preview: vertex selection / paint / vertex drag ---
            if (this.meshSystem.weightPreviewActive && this._meshEditMode) {
                const img = this.imageManager.images.find(i => i.id === this.meshSystem.selectedMeshId);
                if (img) {
                    // Paint mode
                    if (this._meshSubMode === 'paint' && this._meshActiveBone) {
                        this._meshPainting = true;
                        this.meshSystem.paintWeight(
                            img.id, wx, wy,
                            this._meshActiveBone,
                            this._meshBrushRadius,
                            this._meshBrushStrength / 100,
                            img
                        );
                        this.viewport.render();
                        return;
                    }

                    // Select mode: try vertex click
                    const idx = this.meshSystem.hitTestVertex(wx, wy, img, this.viewport.camera.zoom);
                    if (idx >= 0) {
                        this.meshSystem.selectedVertexIdx = idx;
                        this._updateWeightEditor();
                        // Start vertex drag
                        this._draggingVertex = true;
                        this._dragVertexIdx = idx;
                        const mesh = this.meshSystem.getMesh(img.id);
                        if (mesh) {
                            this._dragVertexStart = { x: mesh.vertices[idx].x, y: mesh.vertices[idx].y };
                        }
                        this._dragStartWorld = { x: wx, y: wy };
                        this.viewport.render();
                        return;
                    }
                }
            }

            // --- Auto-rig preview: intercept for landmark dragging ---
            if (this.autoRigger.previewActive) {
                if (this.autoRigger.startDragLandmark(wx, wy, this.viewport.camera.zoom)) {
                    this.viewport.canvas.style.cursor = 'grabbing';
                    this.viewport.render();
                }
                return; // Don't process normal tool interactions during preview
            }

            switch (this.currentTool) {
                case 'select':
                    this._handleSelect(wx, wy);
                    break;
                case 'bone':
                    this._handleBoneCreate(wx, wy);
                    break;
                case 'move':
                    this._handleMoveStart(wx, wy);
                    break;
                case 'rotate':
                    this._handleRotateStart(wx, wy);
                    break;
            }
        });

        bus.on('viewport:mousemove', (data) => {
            const { wx, wy } = data;

            // --- Mesh edit: brush position + paint drag ---
            if (this._meshEditMode) {
                if (this._meshSubMode === 'paint') {
                    this._meshBrushWorldPos = { x: wx, y: wy };
                    if (this._meshPainting && this._meshActiveBone) {
                        const img = this.imageManager.images.find(i => i.id === this.meshSystem.selectedMeshId);
                        if (img) {
                            this.meshSystem.paintWeight(
                                img.id, wx, wy,
                                this._meshActiveBone,
                                this._meshBrushRadius,
                                this._meshBrushStrength / 100,
                                img
                            );
                        }
                    }
                    this.viewport.render();
                    return;
                }

                // Vertex drag in select mode
                if (this._draggingVertex && this._dragVertexIdx >= 0) {
                    const img = this.imageManager.images.find(i => i.id === this.meshSystem.selectedMeshId);
                    if (img) {
                        const dwx = wx - this._dragStartWorld.x;
                        const dwy = wy - this._dragStartWorld.y;
                        // Convert world delta to bone-local delta
                        let ldx = dwx, ldy = dwy;
                        if (img.boneName) {
                            const bone = this.boneSystem.getBoneByName(img.boneName);
                            if (bone) {
                                const pRad = -bone.worldRotation * Math.PI / 180;
                                ldx = dwx * Math.cos(pRad) - dwy * Math.sin(pRad);
                                ldy = dwx * Math.sin(pRad) + dwy * Math.cos(pRad);
                            }
                        }
                        const newX = this._dragVertexStart.x + ldx;
                        const newY = this._dragVertexStart.y + ldy;
                        this.meshSystem.moveVertex(this.meshSystem.selectedMeshId, this._dragVertexIdx, newX, newY, img);
                        this.viewport.render();
                    }
                    return;
                }
            }

            // --- Auto-rig preview: landmark drag ---
            if (this.autoRigger.previewActive) {
                if (this.autoRigger.isDraggingLandmark) {
                    this.autoRigger.dragLandmark(wx, wy);
                    this.viewport.render();
                } else {
                    // Show grab cursor when hovering a landmark
                    const hit = this.autoRigger.hitTestLandmark(wx, wy, this.viewport.camera.zoom);
                    this.viewport.canvas.style.cursor = hit >= 0 ? 'grab' : 'default';
                }
                return;
            }

            // Update bone hover
            if (this.currentTool === 'select' || this.currentTool === 'bone') {
                const threshold = 10 / this.viewport.camera.zoom;
                const bone = this.boneSystem.findBoneAt(wx, wy, threshold);
                if (bone !== this.boneSystem.hoveredBone) {
                    this.boneSystem.hoveredBone = bone;
                    this.viewport.render();
                }
            }

            // Handle bone/image dragging
            if (this._draggingBone || this._draggingImage) {
                this._handleMoveDrag(wx, wy);
            }

            // Handle rotation drag
            if (this._rotatingBone) {
                this._handleRotateDrag(wx, wy);
            }

            // Bone creation preview
            if (this.boneSystem.isCreating) {
                this.viewport.render();
            }
        });

        bus.on('viewport:mouseup', (data) => {
            const { wx, wy } = data;

            // --- Mesh edit: end paint / end vertex drag ---
            if (this._meshPainting) {
                this._meshPainting = false;
            }
            if (this._draggingVertex) {
                this._draggingVertex = false;
                this._dragVertexIdx = -1;
                this._dragVertexStart = null;
            }

            // --- Auto-rig preview: end landmark drag ---
            if (this.autoRigger.isDraggingLandmark) {
                this.autoRigger.endDragLandmark();
                this.viewport.canvas.style.cursor = 'default';
                this.viewport.render();
                return;
            }

            if (this.boneSystem.isCreating) {
                this.boneSystem.finishBoneCreation(wx, wy);
                this.viewport.render();
            }

            // Finish bone drag — push undo
            if (this._draggingBone) {
                const bone = this._draggingBone;
                const startLocal = { ...this._dragStartLocal };
                const endLocal = { x: bone.x, y: bone.y };
                this.history.push({
                    execute: () => { bone.x = endLocal.x; bone.y = endLocal.y; this.boneSystem.updateWorldTransforms(); },
                    undo: () => { bone.x = startLocal.x; bone.y = startLocal.y; this.boneSystem.updateWorldTransforms(); },
                    description: `Move bone ${bone.name}`
                });
                this._draggingBone = null;
                this.viewport.render();
            }

            // Finish image drag — push undo
            if (this._draggingImage) {
                const img = this._draggingImage;
                const startPos = { ...this._dragImageStart };
                const endPos = { x: img.x, y: img.y };
                this.history.push({
                    execute: () => { img.x = endPos.x; img.y = endPos.y; },
                    undo: () => { img.x = startPos.x; img.y = startPos.y; },
                    description: `Move image ${img.name}`
                });
                this._draggingImage = null;
                this.viewport.render();
            }

            // Finish rotation — push undo
            if (this._rotatingBone) {
                const bone = this._rotatingBone;
                const startRot = this._rotateStartRotation;
                const endRot = bone.rotation;
                this.history.push({
                    execute: () => { bone.rotation = endRot; this.boneSystem.updateWorldTransforms(); },
                    undo: () => { bone.rotation = startRot; this.boneSystem.updateWorldTransforms(); },
                    description: `Rotate bone ${bone.name}`
                });
                this._rotatingBone = null;
                this.viewport.render();
            }
        });
    }

    _handleSelect(wx, wy) {
        const threshold = 10 / this.viewport.camera.zoom;

        // Try selecting a bone first
        const bone = this.boneSystem.findBoneAt(wx, wy, threshold);
        if (bone) {
            this.boneSystem.selectBone(bone);
            this.imageManager.selectImage(null);
            this.viewport.render();
            return;
        }

        // Try selecting an image
        const image = this.imageManager.findImageAt(wx, wy, this.boneSystem);
        if (image) {
            this.imageManager.selectImage(image);
            this.boneSystem.selectBone(null);
            this.viewport.render();
            return;
        }

        // Deselect all
        this.boneSystem.selectBone(null);
        this.imageManager.selectImage(null);
        this.viewport.render();
    }

    _handleBoneCreate(wx, wy) {
        if (!this.boneSystem.isCreating) {
            this.boneSystem.startBoneCreation(wx, wy);
        }
    }

    _handleMoveStart(wx, wy) {
        const threshold = 10 / this.viewport.camera.zoom;

        // Try bone first
        const bone = this.boneSystem.findBoneAt(wx, wy, threshold);
        if (bone) {
            this._draggingBone = bone;
            this.boneSystem.selectBone(bone);
            this._dragStartWorld = { x: wx, y: wy };
            this._dragStartLocal = { x: bone.x, y: bone.y };
            return;
        }

        // Try image
        const image = this.imageManager.findImageAt(wx, wy, this.boneSystem);
        if (image) {
            this._draggingImage = image;
            this.imageManager.selectImage(image);
            this._dragStartWorld = { x: wx, y: wy };
            this._dragImageStart = { x: image.x, y: image.y };
            return;
        }
    }

    _handleMoveDrag(wx, wy) {
        const dwx = wx - this._dragStartWorld.x;
        const dwy = wy - this._dragStartWorld.y;

        // Bone dragging
        if (this._draggingBone) {
            const bone = this._draggingBone;
            if (bone.parent) {
                const pRad = -bone.parent.worldRotation * Math.PI / 180;
                bone.x = this._dragStartLocal.x + dwx * Math.cos(pRad) - dwy * Math.sin(pRad);
                bone.y = this._dragStartLocal.y + dwx * Math.sin(pRad) + dwy * Math.cos(pRad);
            } else {
                bone.x = this._dragStartLocal.x + dwx;
                bone.y = this._dragStartLocal.y + dwy;
            }
            this.boneSystem.updateWorldTransforms();
            this.viewport.render();
            bus.emit('bones:changed');
            return;
        }

        // Image dragging
        if (this._draggingImage) {
            const img = this._draggingImage;
            // If bound to a bone, convert world delta to bone-local delta
            if (img.boneName) {
                const bone = this.boneSystem.getBoneByName(img.boneName);
                if (bone) {
                    const pRad = -bone.worldRotation * Math.PI / 180;
                    img.x = this._dragImageStart.x + dwx * Math.cos(pRad) - dwy * Math.sin(pRad);
                    img.y = this._dragImageStart.y + dwx * Math.sin(pRad) + dwy * Math.cos(pRad);
                    this.viewport.render();
                    bus.emit('images:changed');
                    return;
                }
            }
            img.x = this._dragImageStart.x + dwx;
            img.y = this._dragImageStart.y + dwy;
            this.viewport.render();
            bus.emit('images:changed');
        }
    }

    _handleRotateStart(wx, wy) {
        const threshold = 10 / this.viewport.camera.zoom;
        const bone = this.boneSystem.findBoneAt(wx, wy, threshold) || this.boneSystem.selectedBone;
        if (!bone) return;

        this._rotatingBone = bone;
        this.boneSystem.selectBone(bone);
        this._rotateStartRotation = bone.rotation;

        // Angle from bone's world position to mouse
        this._rotateStartAngle = Math.atan2(wy - bone.worldY, wx - bone.worldX);
    }

    _handleRotateDrag(wx, wy) {
        const bone = this._rotatingBone;
        if (!bone) return;

        const currentAngle = Math.atan2(wy - bone.worldY, wx - bone.worldX);
        const deltaAngle = (currentAngle - this._rotateStartAngle) * 180 / Math.PI;
        bone.rotation = this._rotateStartRotation + deltaAngle;

        this.boneSystem.updateWorldTransforms();
        this.viewport.render();
        bus.emit('bones:changed');
    }

    // -------- Keyboard --------

    _setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            // Don't capture if typing in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            switch (e.key.toLowerCase()) {
                case 'v': this.setTool('select'); break;
                case 'b': this.setTool('bone'); break;
                case 'g': this.setTool('move'); break;
                case 'r': this.setTool('rotate'); break;
                case 'h': this.setTool('pan'); break;
                case 'm':
                    if (this._meshEditMode) this._leaveMeshEditMode();
                    else this._enterMeshEditMode();
                    break;
                case 'f':
                    const bounds = this.imageManager.getBounds(this.boneSystem);
                    if (bounds) this.viewport.zoomToFit(bounds);
                    break;
                case 'delete':
                case 'backspace':
                    if (this.boneSystem.selectedBone) {
                        this.boneSystem.removeBone(this.boneSystem.selectedBone);
                        this.viewport.render();
                    }
                    break;
                case 'escape':
                    // Cancel mesh edit mode first if active
                    if (this._meshEditMode) {
                        this._leaveMeshEditMode();
                        break;
                    }
                    // Cancel auto-rig preview first if active
                    if (this.autoRigger.previewActive) {
                        this._cancelAutoRig();
                        break;
                    }
                    this.boneSystem.cancelBoneCreation();
                    this.boneSystem.selectBone(null);
                    this.imageManager.selectImage(null);
                    this.viewport.render();
                    break;
                case 'enter':
                    // Apply weight preview
                    if (this.meshSystem.weightPreviewActive) {
                        this._applyWeights();
                        break;
                    }
                    // Apply auto-rig preview
                    if (this.autoRigger.previewActive) {
                        this._applyAutoRig();
                    }
                    break;
                case 'z':
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        if (e.shiftKey) {
                            if (this.history.redo()) {
                                this.viewport.render();
                                bus.emit('bones:changed');
                                bus.emit('images:changed');
                            }
                        } else {
                            if (this.history.undo()) {
                                this.viewport.render();
                                bus.emit('bones:changed');
                                bus.emit('images:changed');
                            }
                        }
                    }
                    break;
                case 'k':
                    // Insert keyframe
                    if (e.shiftKey) {
                        // Shift+K = keyframe ALL bones
                        if (this.boneSystem.bones.length > 0) {
                            if (!this.animSystem.currentAnimation) {
                                this.animSystem.createAnimation('animation', 2.0);
                            }
                            for (const bone of this.boneSystem.bones) {
                                this.animSystem.insertKeyframe(bone.name);
                            }
                            this.ui.showToast(`Keyframed all ${this.boneSystem.bones.length} bones at ${this.animSystem.currentTime.toFixed(2)}s`, 'success');
                        }
                    } else if (this.boneSystem.selectedBone) {
                        // K = keyframe selected bone
                        if (!this.animSystem.currentAnimation) {
                            this.animSystem.createAnimation('animation', 2.0);
                        }
                        this.animSystem.insertKeyframe(this.boneSystem.selectedBone.name);
                        this.ui.showToast(`Keyframe added at ${this.animSystem.currentTime.toFixed(2)}s`, 'success');
                    }
                    break;
                case ' ':
                    e.preventDefault();
                    if (this.animSystem.currentAnimation) {
                        this.animSystem.togglePlay();
                    }
                    break;
                case 's':
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        this.saveProject();
                    }
                    break;
                case 'o':
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        document.getElementById('file-load-project')?.click();
                    }
                    break;
            }
        });
    }

    // -------- File Operations --------

    _setupFileButtons() {
        // Import image
        const importInput = document.getElementById('file-import-image');
        document.getElementById('btn-import')?.addEventListener('click', () => importInput?.click());
        document.getElementById('btn-add-image')?.addEventListener('click', () => importInput?.click());
        importInput?.addEventListener('change', async (e) => {
            await this.importFiles([...e.target.files]);
            e.target.value = '';
        });

        // Export Spine JSON
        document.getElementById('btn-export')?.addEventListener('click', () => this.exportSpineJSON());

        // Save project
        document.getElementById('btn-save')?.addEventListener('click', () => this.saveProject());

        // Load project
        const loadInput = document.getElementById('file-load-project');
        document.getElementById('btn-load')?.addEventListener('click', () => loadInput?.click());
        loadInput?.addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                await this.loadProject(e.target.files[0]);
                e.target.value = '';
            }
        });

        // Add slot
        document.getElementById('btn-add-slot')?.addEventListener('click', () => {
            this.slotSystem.autoCreateSlots();
            this.ui.showToast('Auto-created slots for images', 'success');
        });
    }

    async importFiles(files) {
        let count = 0;
        for (const file of files) {
            // Handle PSD files
            if (file.name.toLowerCase().endsWith('.psd')) {
                try {
                    this.ui.showToast(`Importing PSD: ${file.name}...`, 'info');
                    const entries = await importPsd(file);
                    for (const entry of entries) {
                        this.imageManager.addImageEntry(entry);
                        count++;
                    }
                    this.ui.showToast(`Imported ${entries.length} layer${entries.length > 1 ? 's' : ''} from ${file.name}`, 'success');
                } catch (err) {
                    console.error('PSD import error:', err);
                    this.ui.showToast(`Failed to import PSD: ${file.name}`, 'error');
                }
                continue;
            }

            // Handle regular image files
            if (file.type.startsWith('image/')) {
                try {
                    await this.imageManager.addImage(file);
                    count++;
                } catch (err) {
                    console.error(err);
                    this.ui.showToast(`Failed to import: ${file.name}`, 'error');
                }
            }
        }

        if (count > 0) {
            // Zoom to fit the imported images
            const bounds = this.imageManager.getBounds(this.boneSystem);
            if (bounds) this.viewport.zoomToFit(bounds);
            this.viewport.render();
        }
    }

    exportSpineJSON() {
        if (this.boneSystem.bones.length === 0) {
            this.ui.showToast('No bones to export. Create bones first.', 'warning');
            return;
        }

        // Auto-create slots if needed
        if (this.slotSystem.slots.length === 0 && this.imageManager.images.length > 0) {
            this.slotSystem.autoCreateSlots();
        }

        this.exporter.downloadJSON('skeleton.json');
        this.ui.showToast('Exported skeleton.json', 'success');
    }

    saveProject() {
        const project = {
            version: '0.1.0',
            bones: this.boneSystem.toJSON().map(bone => ({
                name: bone.name,
                parent: bone.parent?.name || null,
                x: bone.x,
                y: bone.y,
                rotation: bone.rotation,
                scaleX: bone.scaleX,
                scaleY: bone.scaleY,
                length: bone.length
            })),
            slots: this.slotSystem.toJSON(),
            images: this.imageManager.images.map(img => ({
                name: img.name,
                x: img.x,
                y: img.y,
                rotation: img.rotation,
                scaleX: img.scaleX,
                scaleY: img.scaleY,
                opacity: img.opacity,
                visible: img.visible,
                slotName: img.slotName,
                boneName: img.boneName,
                dataURL: this.imageManager.getImageDataURL(img)
            }))
        };

        const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'project.spine2d';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this.ui.showToast('Project saved', 'success');
    }

    async loadProject(file) {
        try {
            const text = await file.text();
            const project = JSON.parse(text);

            // Clear existing
            this.boneSystem.bones = [];
            this.boneSystem.rootBones = [];
            this.boneSystem.selectedBone = null;
            this.imageManager.images = [];
            this.imageManager.selectedImage = null;

            // Load bones
            if (project.bones) {
                this.boneSystem.fromJSON(project.bones);
            }

            // Load images
            if (project.images) {
                for (const imgData of project.images) {
                    await new Promise((resolve, reject) => {
                        const img = new Image();
                        img.onload = () => {
                            const entry = {
                                id: Date.now() + Math.random(),
                                name: imgData.name,
                                file: null,
                                img: img,
                                width: img.naturalWidth,
                                height: img.naturalHeight,
                                x: imgData.x,
                                y: imgData.y,
                                rotation: imgData.rotation || 0,
                                scaleX: imgData.scaleX ?? 1,
                                scaleY: imgData.scaleY ?? 1,
                                visible: imgData.visible ?? true,
                                opacity: imgData.opacity ?? 1,
                                slotName: imgData.slotName,
                                boneName: imgData.boneName
                            };
                            this.imageManager.images.push(entry);
                            resolve();
                        };
                        img.onerror = reject;
                        img.src = imgData.dataURL;
                    });
                }
            }

            // Load slots
            if (project.slots) {
                this.slotSystem.fromJSON(project.slots);
            }

            bus.emit('images:changed');
            bus.emit('bones:changed');
            bus.emit('slots:changed');

            const bounds = this.imageManager.getBounds(this.boneSystem);
            if (bounds) this.viewport.zoomToFit(bounds);
            this.viewport.render();

            this.ui.showToast('Project loaded', 'success');
        } catch (err) {
            console.error('Failed to load project:', err);
            this.ui.showToast('Failed to load project', 'error');
        }
    }

    _updateStatusInfo() {
        this.ui.setStatusInfo(`Bones: ${this.boneSystem.bones.length} | Images: ${this.imageManager.images.length} | Slots: ${this.slotSystem.slots.length}`);
    }
}

// -------- Initialize --------
window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
