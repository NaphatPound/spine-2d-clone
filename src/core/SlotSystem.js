/**
 * SlotSystem — Manages slots that link bones to image attachments.
 * Mirrors Spine's slot concept: a slot sits on a bone and holds an attachment.
 */
import { bus } from './EventBus.js';

let slotIdCounter = 0;

export default class SlotSystem {
    constructor(boneSystem, imageManager) {
        this.boneSystem = boneSystem;
        this.imageManager = imageManager;
        this.slots = [];          // ordered by draw order
        this.selectedSlot = null;
    }

    addSlot(name, boneName, attachmentName = null) {
        const slot = {
            id: ++slotIdCounter,
            name: name || `slot_${slotIdCounter}`,
            bone: boneName,                    // bone name string
            attachment: attachmentName,        // current visible attachment name
            color: 'ffffffff',                 // RGBA hex
            dark: null                         // two-color tint (optional)
        };
        this.slots.push(slot);
        bus.emit('slots:changed');
        return slot;
    }

    removeSlot(slot) {
        this.slots = this.slots.filter(s => s !== slot);
        if (this.selectedSlot === slot) {
            this.selectedSlot = null;
        }
        bus.emit('slots:changed');
    }

    selectSlot(slot) {
        this.selectedSlot = slot;
        bus.emit('slots:selected', slot);
    }

    getSlotByName(name) {
        return this.slots.find(s => s.name === name);
    }

    getSlotsForBone(boneName) {
        return this.slots.filter(s => s.bone === boneName);
    }

    /**
     * Auto-create slots: one slot per image, bound to a matching bone.
     * Matching priority:
     *   1. Exact name match (image "head" → bone "head")
     *   2. Partial match (image "head_color" → bone "head", or "left_arm" → "left_upper_arm")
     *   3. Fallback: nearest bone to image center
     */
    autoCreateSlots() {
        const bones = this.boneSystem.bones;
        if (bones.length === 0) return;

        for (const img of this.imageManager.images) {
            if (img.slotName) continue; // already has a slot

            const matchedBone = this._findMatchingBone(img, bones);
            const boneName = matchedBone.name;
            const slotName = img.name;
            this.addSlot(slotName, boneName, img.name);
            img.slotName = slotName;
            img.boneName = boneName;

            // Convert image position from world-space to bone-local-space
            const rad = -matchedBone.worldRotation * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const dx = img.x - matchedBone.worldX;
            const dy = img.y - matchedBone.worldY;
            img.x = dx * cos - dy * sin;
            img.y = dx * sin + dy * cos;
        }
        bus.emit('slots:changed');
    }

    /**
     * Find the best matching bone for an image using name matching,
     * then fallback to nearest bone.
     */
    _findMatchingBone(img, bones) {
        const imgName = img.name.toLowerCase().replace(/[^a-z0-9]/g, '_');

        // 1. Exact name match
        for (const bone of bones) {
            if (bone.name.toLowerCase() === imgName) return bone;
        }

        // 2. Partial match — image name contains bone name (longest match wins)
        let bestMatch = null;
        let bestLen = 0;
        for (const bone of bones) {
            const bn = bone.name.toLowerCase();
            if (bn === 'root') continue; // don't match everything to root
            if (imgName.includes(bn) || bn.includes(imgName)) {
                if (bn.length > bestLen) {
                    bestLen = bn.length;
                    bestMatch = bone;
                }
            }
        }
        if (bestMatch) return bestMatch;

        // 3. Fallback: nearest bone to image center
        const cx = img.x + img.width / 2;
        const cy = img.y + img.height / 2;
        let nearestBone = bones[0];
        let nearestDist = Infinity;

        for (const bone of bones) {
            const dx = cx - bone.worldX;
            const dy = cy - bone.worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearestBone = bone;
            }
        }
        return nearestBone;
    }

    reorder(fromIndex, toIndex) {
        const [item] = this.slots.splice(fromIndex, 1);
        this.slots.splice(toIndex, 0, item);
        bus.emit('slots:changed');
    }

    toJSON() {
        return this.slots.map(s => ({
            name: s.name,
            bone: s.bone,
            ...(s.attachment ? { attachment: s.attachment } : {}),
            ...(s.color !== 'ffffffff' ? { color: s.color } : {})
        }));
    }

    fromJSON(slotsData) {
        this.slots = [];
        slotIdCounter = 0;
        for (const data of slotsData) {
            this.addSlot(data.name, data.bone, data.attachment);
        }
        bus.emit('slots:changed');
    }
}
