/**
 * BoneSystem — Manages bone hierarchy, selection, creation, and rendering.
 * Bones use Spine conventions: position/rotation relative to parent.
 */
import { bus } from './EventBus.js';

let boneIdCounter = 0;

export function createBone(name, parent = null, props = {}) {
    return {
        id: ++boneIdCounter,
        name: name || `bone_${boneIdCounter}`,
        parent: parent,          // reference to parent bone or null
        children: [],
        x: props.x || 0,        // local position relative to parent
        y: props.y || 0,
        rotation: props.rotation || 0,  // degrees, relative to parent
        scaleX: props.scaleX ?? 1,
        scaleY: props.scaleY ?? 1,
        length: props.length || 0,
        color: props.color || '#c8d850',
        // Computed world transform (updated by updateWorldTransforms)
        worldX: 0,
        worldY: 0,
        worldRotation: 0
    };
}

export default class BoneSystem {
    constructor() {
        this.bones = [];          // flat list
        this.rootBones = [];      // bones with no parent
        this.selectedBone = null;
        this.hoveredBone = null;

        // For bone creation
        this._creatingBone = false;
        this._createStart = null;
    }

    addBone(name, parentBone = null, props = {}) {
        const bone = createBone(name, parentBone, props);
        this.bones.push(bone);
        if (parentBone) {
            parentBone.children.push(bone);
        } else {
            this.rootBones.push(bone);
        }
        this.updateWorldTransforms();
        bus.emit('bones:changed');
        bus.emit('bones:added', bone);
        return bone;
    }

    removeBone(bone) {
        // Remove children recursively
        const children = [...bone.children];
        for (const child of children) {
            this.removeBone(child);
        }

        // Remove from parent's children
        if (bone.parent) {
            bone.parent.children = bone.parent.children.filter(c => c !== bone);
        } else {
            this.rootBones = this.rootBones.filter(b => b !== bone);
        }

        // Remove from flat list
        this.bones = this.bones.filter(b => b !== bone);

        if (this.selectedBone === bone) {
            this.selectedBone = null;
            bus.emit('bones:selected', null);
        }

        this.updateWorldTransforms();
        bus.emit('bones:changed');
        bus.emit('bones:removed', bone);
    }

    renameBone(bone, newName) {
        // Ensure unique name
        let name = newName;
        let counter = 1;
        while (this.bones.some(b => b !== bone && b.name === name)) {
            name = `${newName}_${counter++}`;
        }
        bone.name = name;
        bus.emit('bones:changed');
    }

    selectBone(bone) {
        this.selectedBone = bone;
        bus.emit('bones:selected', bone);
    }

    findBoneAt(wx, wy, threshold = 8) {
        // Find the bone closest to the world position
        let closest = null;
        let closestDist = threshold;

        for (const bone of this.bones) {
            // Check distance to bone joint (world position)
            const dx = wx - bone.worldX;
            const dy = wy - bone.worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < closestDist) {
                closestDist = dist;
                closest = bone;
            }

            // Also check along the bone body if it has length
            if (bone.length > 0) {
                const rad = bone.worldRotation * Math.PI / 180;
                const endX = bone.worldX + Math.cos(rad) * bone.length;
                const endY = bone.worldY + Math.sin(rad) * bone.length;

                const segDist = this._pointToSegmentDist(wx, wy, bone.worldX, bone.worldY, endX, endY);
                if (segDist < closestDist) {
                    closestDist = segDist;
                    closest = bone;
                }
            }
        }

        return closest;
    }

    _pointToSegmentDist(px, py, ax, ay, bx, by) {
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);

        let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const projX = ax + t * dx;
        const projY = ay + t * dy;
        return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
    }

    getBoneByName(name) {
        return this.bones.find(b => b.name === name);
    }

    // -------- World Transform Computation --------

    updateWorldTransforms() {
        for (const root of this.rootBones) {
            this._computeWorld(root, 0, 0, 0);
        }
    }

    _computeWorld(bone, parentWorldX, parentWorldY, parentWorldRotation) {
        const rad = parentWorldRotation * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        // Rotate local position by parent's world rotation
        bone.worldX = parentWorldX + bone.x * cos - bone.y * sin;
        bone.worldY = parentWorldY + bone.x * sin + bone.y * cos;
        bone.worldRotation = parentWorldRotation + bone.rotation;

        for (const child of bone.children) {
            // Child's origin is at the end of this bone (along its length)
            const boneRad = bone.worldRotation * Math.PI / 180;
            const endX = bone.worldX + Math.cos(boneRad) * bone.length;
            const endY = bone.worldY + Math.sin(boneRad) * bone.length;
            this._computeWorld(child, endX, endY, bone.worldRotation);
        }
    }

    // -------- Bone Creation Mode --------

    startBoneCreation(wx, wy) {
        this._creatingBone = true;
        this._createStart = { x: wx, y: wy };
    }

    finishBoneCreation(wx, wy) {
        if (!this._creatingBone) return null;
        this._creatingBone = false;

        const sx = this._createStart.x;
        const sy = this._createStart.y;
        const dx = wx - sx;
        const dy = wy - sy;
        const length = Math.sqrt(dx * dx + dy * dy);
        const rotation = Math.atan2(dy, dx) * 180 / Math.PI;

        if (length < 5) return null; // too short

        // Find parent: bone closest to start point, or selected bone
        let parent = this.selectedBone;
        if (!parent) {
            parent = this.findBoneAt(sx, sy, 15);
        }

        let localX, localY, localRotation;

        if (parent) {
            // Convert start position to parent-local coordinates
            const parentEnd = this._getBoneEndWorld(parent);
            localX = sx - parentEnd.x;
            localY = sy - parentEnd.y;

            // Unrotate by parent's world rotation
            const pRad = -parent.worldRotation * Math.PI / 180;
            const rx = localX * Math.cos(pRad) - localY * Math.sin(pRad);
            const ry = localX * Math.sin(pRad) + localY * Math.cos(pRad);
            localX = rx;
            localY = ry;
            localRotation = rotation - parent.worldRotation;
        } else {
            localX = sx;
            localY = sy;
            localRotation = rotation;
        }

        const bone = this.addBone(null, parent, {
            x: localX,
            y: localY,
            rotation: localRotation,
            length: length
        });

        this.selectBone(bone);
        return bone;
    }

    _getBoneEndWorld(bone) {
        const rad = bone.worldRotation * Math.PI / 180;
        return {
            x: bone.worldX + Math.cos(rad) * bone.length,
            y: bone.worldY + Math.sin(rad) * bone.length
        };
    }

    cancelBoneCreation() {
        this._creatingBone = false;
        this._createStart = null;
    }

    get isCreating() {
        return this._creatingBone;
    }

    get createStart() {
        return this._createStart;
    }

    // -------- Rendering --------

    render(ctx, viewport) {
        const zoom = viewport.camera.zoom;

        // Draw all bones
        for (const bone of this.bones) {
            this._drawBone(ctx, bone, zoom);
        }

        // Draw bone creation preview
        if (this._creatingBone && this._createStart) {
            const mx = viewport.worldMouse.x;
            const my = viewport.worldMouse.y;
            ctx.save();
            ctx.strokeStyle = 'rgba(200, 216, 80, 0.5)';
            ctx.lineWidth = 2 / zoom;
            ctx.setLineDash([4 / zoom, 4 / zoom]);
            ctx.beginPath();
            ctx.moveTo(this._createStart.x, this._createStart.y);
            ctx.lineTo(mx, my);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }
    }

    _drawBone(ctx, bone, zoom) {
        const isSelected = bone === this.selectedBone;
        const isHovered = bone === this.hoveredBone;

        const x = bone.worldX;
        const y = bone.worldY;
        const rad = bone.worldRotation * Math.PI / 180;
        const boneColor = bone.color || '#c8d850';

        // Parse hex color to rgba for fill tint
        const r = parseInt(boneColor.slice(1, 3), 16);
        const g = parseInt(boneColor.slice(3, 5), 16);
        const b = parseInt(boneColor.slice(5, 7), 16);
        const fillTint = `rgba(${r}, ${g}, ${b}, 0.2)`;
        const fillTintHover = `rgba(${r}, ${g}, ${b}, 0.3)`;

        // Joint circle
        const jointRadius = isSelected ? 5 / zoom : (isHovered ? 4.5 / zoom : 3.5 / zoom);
        ctx.fillStyle = isSelected ? '#f0f060' : (isHovered ? boneColor : boneColor);
        ctx.beginPath();
        ctx.arc(x, y, jointRadius, 0, Math.PI * 2);
        ctx.fill();

        if (isSelected) {
            ctx.strokeStyle = 'rgba(240, 240, 96, 0.4)';
            ctx.lineWidth = 2 / zoom;
            ctx.beginPath();
            ctx.arc(x, y, jointRadius + 3 / zoom, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Bone body (diamond shape)
        if (bone.length > 0) {
            const endX = x + Math.cos(rad) * bone.length;
            const endY = y + Math.sin(rad) * bone.length;
            const perpX = -Math.sin(rad) * 6 / zoom;
            const perpY = Math.cos(rad) * 6 / zoom;
            const midFactor = 0.25;
            const midX = x + Math.cos(rad) * bone.length * midFactor;
            const midY = y + Math.sin(rad) * bone.length * midFactor;

            ctx.fillStyle = isSelected
                ? 'rgba(240, 240, 96, 0.25)'
                : (isHovered ? fillTintHover : fillTint);
            ctx.strokeStyle = isSelected ? '#f0f060' : boneColor;
            ctx.lineWidth = 1.2 / zoom;

            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(midX + perpX, midY + perpY);
            ctx.lineTo(endX, endY);
            ctx.lineTo(midX - perpX, midY - perpY);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }

        // Name label (only when zoomed in enough)
        if (zoom > 0.5 && (isSelected || isHovered)) {
            ctx.fillStyle = isSelected ? '#f0f060' : boneColor;
            ctx.font = `${11 / zoom}px Inter, sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText(bone.name, x + 8 / zoom, y - 8 / zoom);
        }
    }

    // -------- Serialization --------

    toJSON() {
        const ordered = [];
        const visit = (bone) => {
            ordered.push(bone);
            for (const child of bone.children) visit(child);
        };
        for (const root of this.rootBones) visit(root);
        return ordered;
    }

    fromJSON(bonesData) {
        this.bones = [];
        this.rootBones = [];
        this.selectedBone = null;
        boneIdCounter = 0;

        const boneMap = {};
        for (const data of bonesData) {
            const parent = data.parent ? boneMap[data.parent] : null;
            const bone = this.addBone(data.name, parent, {
                x: data.x || 0,
                y: data.y || 0,
                rotation: data.rotation || 0,
                scaleX: data.scaleX ?? 1,
                scaleY: data.scaleY ?? 1,
                length: data.length || 0,
                color: data.color
            });
            boneMap[bone.name] = bone;
        }
        this.updateWorldTransforms();
        bus.emit('bones:changed');
    }
}
