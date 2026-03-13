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

    /**
     * Add a pre-built image entry (e.g. from PSD import).
     * @param {Object} entry - Image entry with id, name, img, width, height, x, y, etc.
     */
    addImageEntry(entry) {
        // Ensure unique ID
        entry.id = ++imageIdCounter;
        this.images.push(entry);
        bus.emit('images:changed');
        bus.emit('images:added', entry);
        return entry;
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

    /**
     * Trim an image to its non-transparent content area.
     * Scans the alpha channel to find the bounding box of visible pixels,
     * then crops the image and updates position/size.
     * @param {object} entry - Image entry to trim
     * @returns {boolean} true if trimmed, false if nothing to trim
     */
    trimToContent(entry) {
        const img = entry.img;
        if (!img) return false;

        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (w === 0 || h === 0) return false;

        // Draw to temp canvas to read pixels
        const scanCanvas = document.createElement('canvas');
        scanCanvas.width = w;
        scanCanvas.height = h;
        const scanCtx = scanCanvas.getContext('2d');
        scanCtx.drawImage(img, 0, 0);
        const data = scanCtx.getImageData(0, 0, w, h).data;

        // Find bounding box of non-transparent pixels
        let minX = w, minY = h, maxX = 0, maxY = 0;
        let found = false;

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const alpha = data[(y * w + x) * 4 + 3];
                if (alpha > 5) { // threshold to ignore near-zero alpha
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    found = true;
                }
            }
        }

        if (!found) return false;

        const cropW = maxX - minX + 1;
        const cropH = maxY - minY + 1;

        // Skip if already tight (less than 2px margin)
        if (minX <= 1 && minY <= 1 && cropW >= w - 2 && cropH >= h - 2) return false;

        // Create cropped canvas
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = cropW;
        cropCanvas.height = cropH;
        const cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(img, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

        // Use the canvas directly as the drawable (works with ctx.drawImage)
        // This avoids async Image load issues
        cropCanvas.naturalWidth = cropW;
        cropCanvas.naturalHeight = cropH;

        // Store original bounds (pre-trim) for consistent auto-rig compositing
        if (!entry._originalBounds) {
            entry._originalBounds = {
                x: entry.x,
                y: entry.y,
                width: entry.width,
                height: entry.height
            };
        }

        // Update position: shift by trim offset (in world space)
        entry.x += minX * entry.scaleX;
        entry.y += minY * entry.scaleY;
        entry.width = cropW;
        entry.height = cropH;
        entry.img = cropCanvas;

        bus.emit('images:changed');
        return true;
    }

    /**
     * Trim all images to their non-transparent content.
     * @returns {number} Number of images trimmed
     */
    trimAllToContent() {
        let count = 0;
        for (const img of this.images) {
            if (this.trimToContent(img)) count++;
        }
        return count;
    }

    /**
     * Remove small disconnected pixel fragments (noise) from an image.
     * Uses flood-fill to find connected components, keeps only the largest one.
     * @param {object} entry - Image entry to clean
     * @returns {boolean} true if noise was removed
     */
    removeNoise(entry) {
        const img = entry.img;
        if (!img) return false;

        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (w === 0 || h === 0) return false;

        // Draw to temp canvas to read pixels
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;

        // Label connected components using flood-fill (4-connected)
        const labels = new Int32Array(w * h);
        const componentSizes = [0]; // index 0 = background
        let currentLabel = 0;
        const alphaThreshold = 10;

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = y * w + x;
                if (labels[idx] !== 0) continue;
                if (data[idx * 4 + 3] < alphaThreshold) continue;

                // BFS flood-fill
                currentLabel++;
                let size = 0;
                const queue = [idx];
                labels[idx] = currentLabel;

                while (queue.length > 0) {
                    const ci = queue.pop();
                    size++;
                    const cx = ci % w;
                    const cy = (ci - cx) / w;

                    // 4-connected neighbors
                    const neighbors = [];
                    if (cx > 0) neighbors.push(ci - 1);
                    if (cx < w - 1) neighbors.push(ci + 1);
                    if (cy > 0) neighbors.push(ci - w);
                    if (cy < h - 1) neighbors.push(ci + w);

                    for (const ni of neighbors) {
                        if (labels[ni] !== 0) continue;
                        if (data[ni * 4 + 3] < alphaThreshold) continue;
                        labels[ni] = currentLabel;
                        queue.push(ni);
                    }
                }
                componentSizes.push(size);
            }
        }

        if (currentLabel <= 1) return false; // 0 or 1 component, nothing to remove

        // Find the largest component
        let largestLabel = 1;
        let largestSize = 0;
        for (let i = 1; i <= currentLabel; i++) {
            if (componentSizes[i] > largestSize) {
                largestSize = componentSizes[i];
                largestLabel = i;
            }
        }

        // Clear pixels not in the largest component
        let removedPixels = 0;
        for (let i = 0; i < w * h; i++) {
            if (data[i * 4 + 3] >= alphaThreshold && labels[i] !== largestLabel) {
                data[i * 4] = 0;
                data[i * 4 + 1] = 0;
                data[i * 4 + 2] = 0;
                data[i * 4 + 3] = 0;
                removedPixels++;
            }
        }

        if (removedPixels === 0) return false;

        // Write cleaned image back
        ctx.putImageData(imageData, 0, 0);
        canvas.naturalWidth = w;
        canvas.naturalHeight = h;
        entry.img = canvas;

        bus.emit('images:changed');
        return true;
    }

    /**
     * Remove noise from all images.
     * @returns {number} Number of images cleaned
     */
    removeNoiseAll() {
        let count = 0;
        for (const img of this.images) {
            if (this.removeNoise(img)) count++;
        }
        return count;
    }

    reorder(fromIndex, toIndex) {
        const [item] = this.images.splice(fromIndex, 1);
        this.images.splice(toIndex, 0, item);
        bus.emit('images:changed');
    }

    findImageAt(wx, wy, boneSystem = null) {
        // Check in reverse draw order (top-most first)
        for (let i = this.images.length - 1; i >= 0; i--) {
            const img = this.images[i];
            if (!img.visible) continue;

            // Get effective world position considering bone binding
            const { ex, ey } = this._getImageWorldPos(img, boneSystem);

            if (wx >= ex && wx <= ex + img.width * img.scaleX &&
                wy >= ey && wy <= ey + img.height * img.scaleY) {
                return img;
            }
        }
        return null;
    }

    /**
     * Get the effective world position of an image.
     * Images always store world positions (boneName is organizational only).
     */
    _getImageWorldPos(entry, boneSystem) {
        return { ex: entry.x, ey: entry.y, bone: null };
    }

    /**
     * Hit-test: find which image is at world position (wx, wy).
     * Tests from top (last rendered) to bottom.
     */
    hitTestImage(wx, wy) {
        for (let i = this.images.length - 1; i >= 0; i--) {
            const img = this.images[i];
            if (!img.visible) continue;
            const x = img.x;
            const y = img.y;
            const w = img.width * img.scaleX;
            const h = img.height * img.scaleY;
            if (wx >= x && wx <= x + w && wy >= y && wy <= y + h) {
                return img;
            }
        }
        return null;
    }

    // -------- Rendering --------

    render(ctx, viewport, boneSystem = null, meshSystem = null) {
        for (const entry of this.images) {
            if (!entry.visible) continue;

            // If a weighted mesh exists for this image, use mesh-deformed rendering
            if (meshSystem && meshSystem.renderMeshDeformed(ctx, entry)) {
                // Mesh rendered — draw selection outline in world space
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
                continue;
            }

            // Render image at world position
            ctx.save();
            ctx.globalAlpha = entry.opacity;
            ctx.translate(entry.x + (entry.width * entry.scaleX) / 2,
                entry.y + (entry.height * entry.scaleY) / 2);
            ctx.rotate((entry.rotation || 0) * Math.PI / 180);
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

    getBounds(boneSystem = null) {
        if (this.images.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const img of this.images) {
            const { ex, ey } = this._getImageWorldPos(img, boneSystem);
            minX = Math.min(minX, ex);
            minY = Math.min(minY, ey);
            maxX = Math.max(maxX, ex + img.width * img.scaleX);
            maxY = Math.max(maxY, ey + img.height * img.scaleY);
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
}
