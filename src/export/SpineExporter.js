/**
 * SpineExporter — Exports project data as Spine-compatible JSON.
 * Targets Spine 4.1 format by default.
 */

export default class SpineExporter {
    constructor(boneSystem, slotSystem, imageManager, animationSystem = null) {
        this.boneSystem = boneSystem;
        this.slotSystem = slotSystem;
        this.imageManager = imageManager;
        this.animationSystem = animationSystem;
        this.spineVersion = '4.1.00';
    }

    export() {
        const bones = this._exportBones();
        const slots = this.slotSystem.toJSON();
        const skins = this._exportSkins();
        const bounds = this._computeBounds();

        const json = {
            skeleton: {
                hash: this._generateHash(),
                spine: this.spineVersion,
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
                images: './images/',
                audio: ''
            },
            bones: bones,
            slots: slots,
            skins: skins,
            animations: this._exportAnimations()
        };

        return json;
    }

    exportAsString(prettyPrint = true) {
        const json = this.export();
        return prettyPrint
            ? JSON.stringify(json, null, 2)
            : JSON.stringify(json);
    }

    downloadJSON(filename = 'skeleton.json') {
        const str = this.exportAsString(true);
        const blob = new Blob([str], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // -------- Internal --------

    _exportBones() {
        const orderedBones = this.boneSystem.toJSON();
        return orderedBones.map(bone => {
            const data = { name: bone.name };
            if (bone.parent) data.parent = bone.parent.name;
            if (bone.length) data.length = Math.round(bone.length * 100) / 100;
            if (bone.x) data.x = Math.round(bone.x * 100) / 100;
            if (bone.y) data.y = Math.round(bone.y * 100) / 100;
            if (bone.rotation) data.rotation = Math.round(bone.rotation * 100) / 100;
            if (bone.scaleX !== 1) data.scaleX = bone.scaleX;
            if (bone.scaleY !== 1) data.scaleY = bone.scaleY;
            return data;
        });
    }

    _exportSkins() {
        const attachments = {};

        for (const slot of this.slotSystem.slots) {
            if (!slot.attachment) continue;

            const image = this.imageManager.images.find(img => img.name === slot.attachment);
            if (!image) continue;

            const bone = this.boneSystem.getBoneByName(slot.bone);
            if (!bone) continue;

            // Compute attachment position relative to the bone
            const relX = (image.x + image.width / 2) - bone.worldX;
            const relY = (image.y + image.height / 2) - bone.worldY;

            // Unrotate by bone's world rotation
            const bRad = -bone.worldRotation * Math.PI / 180;
            const localX = relX * Math.cos(bRad) - relY * Math.sin(bRad);
            const localY = relX * Math.sin(bRad) + relY * Math.cos(bRad);

            const attachmentData = {
                x: Math.round(localX * 100) / 100,
                y: Math.round(localY * 100) / 100,
                width: image.width,
                height: image.height
            };

            if (image.rotation) {
                attachmentData.rotation = image.rotation - bone.worldRotation;
            }
            if (image.scaleX !== 1) attachmentData.scaleX = image.scaleX;
            if (image.scaleY !== 1) attachmentData.scaleY = image.scaleY;

            if (!attachments[slot.name]) attachments[slot.name] = {};
            attachments[slot.name][slot.attachment] = attachmentData;
        }

        return [{
            name: 'default',
            attachments: attachments
        }];
    }

    _computeBounds() {
        const bounds = this.imageManager.getBounds();
        if (!bounds) {
            return { x: -100, y: -100, width: 200, height: 200 };
        }
        return {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height)
        };
    }

    _generateHash() {
        // Simple hash for change detection
        const data = JSON.stringify({
            bones: this.boneSystem.bones.length,
            slots: this.slotSystem.slots.length,
            images: this.imageManager.images.length,
            time: Date.now()
        });
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
            const char = data.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    }

    _exportAnimations() {
        if (!this.animationSystem || this.animationSystem.animations.length === 0) {
            return {};
        }
        return this.animationSystem.toJSON();
    }
}
