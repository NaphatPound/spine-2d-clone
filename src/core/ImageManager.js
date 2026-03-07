/**
 * ImageManager — Manages imported images (PNG layers) for the editor.
 */
import { bus } from './EventBus.js';

let imageIdCounter = 0;

export default class ImageManager {
    constructor() {
        this.images = [];        // ordered list (draw order)
        this.selectedImage = null;
    }

    async addImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const entry = {
                        id: ++imageIdCounter,
                        name: file.name.replace(/\.\w+$/, ''),
                        file: file,
                        img: img,
                        width: img.naturalWidth,
                        height: img.naturalHeight,
                        x: 0,
                        y: 0,
                        rotation: 0,
                        scaleX: 1,
                        scaleY: 1,
                        visible: true,
                        opacity: 1,
                        // For slot binding
                        slotName: null,
                        boneName: null
                    };
                    // Center the image at origin
                    entry.x = -entry.width / 2;
                    entry.y = -entry.height / 2;

                    this.images.push(entry);
                    bus.emit('images:changed');
                    bus.emit('images:added', entry);
                    resolve(entry);
                };
                img.onerror = () => reject(new Error(`Failed to load image: ${file.name}`));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
            reader.readAsDataURL(file);
        });
    }

    removeImage(entry) {
        this.images = this.images.filter(i => i !== entry);
        if (this.selectedImage === entry) {
            this.selectedImage = null;
            bus.emit('images:selected', null);
        }
        bus.emit('images:changed');
        bus.emit('images:removed', entry);
    }

    selectImage(entry) {
        this.selectedImage = entry;
        bus.emit('images:selected', entry);
    }

    toggleVisibility(entry) {
        entry.visible = !entry.visible;
        bus.emit('images:changed');
    }

    moveImage(entry, x, y) {
        entry.x = x;
        entry.y = y;
        bus.emit('images:changed');
    }

    reorder(fromIndex, toIndex) {
        const [item] = this.images.splice(fromIndex, 1);
        this.images.splice(toIndex, 0, item);
        bus.emit('images:changed');
    }

    findImageAt(wx, wy) {
        // Check in reverse draw order (top-most first)
        for (let i = this.images.length - 1; i >= 0; i--) {
            const img = this.images[i];
            if (!img.visible) continue;
            if (wx >= img.x && wx <= img.x + img.width * img.scaleX &&
                wy >= img.y && wy <= img.y + img.height * img.scaleY) {
                return img;
            }
        }
        return null;
    }

    // -------- Rendering --------

    render(ctx, viewport) {
        for (const entry of this.images) {
            if (!entry.visible) continue;

            ctx.save();
            ctx.globalAlpha = entry.opacity;
            ctx.translate(entry.x + (entry.width * entry.scaleX) / 2,
                entry.y + (entry.height * entry.scaleY) / 2);
            ctx.rotate(entry.rotation * Math.PI / 180);
            ctx.scale(entry.scaleX, entry.scaleY);
            ctx.drawImage(entry.img, -entry.width / 2, -entry.height / 2);
            ctx.restore();

            // Selection outline
            if (entry === this.selectedImage) {
                const zoom = viewport.camera.zoom;
                ctx.save();
                ctx.strokeStyle = '#4f9cf7';
                ctx.lineWidth = 1.5 / zoom;
                ctx.setLineDash([5 / zoom, 3 / zoom]);
                ctx.strokeRect(entry.x, entry.y,
                    entry.width * entry.scaleX,
                    entry.height * entry.scaleY);
                ctx.setLineDash([]);
                ctx.restore();
            }
        }
    }

    getImageDataURL(entry) {
        const canvas = document.createElement('canvas');
        canvas.width = entry.width;
        canvas.height = entry.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(entry.img, 0, 0);
        return canvas.toDataURL('image/png');
    }

    getBounds() {
        if (this.images.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const img of this.images) {
            minX = Math.min(minX, img.x);
            minY = Math.min(minY, img.y);
            maxX = Math.max(maxX, img.x + img.width * img.scaleX);
            maxY = Math.max(maxY, img.y + img.height * img.scaleY);
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
}
