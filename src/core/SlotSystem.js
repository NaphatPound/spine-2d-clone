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
     * Auto-create slots: one slot per image, bound to the nearest bone.
     */
    autoCreateSlots() {
        for (const img of this.imageManager.images) {
            if (img.slotName) continue; // already has a slot

            // Find nearest bone to the image center
            const cx = img.x + img.width / 2;
            const cy = img.y + img.height / 2;
            let nearestBone = null;
            let nearestDist = Infinity;

            for (const bone of this.boneSystem.bones) {
                const dx = cx - bone.worldX;
                const dy = cy - bone.worldY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestBone = bone;
                }
            }

            const boneName = nearestBone ? nearestBone.name : 'root';
            const slotName = img.name;
            const slot = this.addSlot(slotName, boneName, img.name);
            img.slotName = slotName;
            img.boneName = boneName;
        }
        bus.emit('slots:changed');
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
