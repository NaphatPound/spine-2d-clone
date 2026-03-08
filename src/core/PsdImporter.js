/**
 * PsdImporter — Parses .psd files and extracts layers as image entries
 * compatible with ImageManager.
 */
import { readPsd } from 'ag-psd';

let psdIdCounter = 0;

/**
 * Flatten ALL non-group layers from the PSD layer tree.
 * Hidden layers are included but marked as hidden so the user can toggle them.
 * @param {Object[]} layers - PSD layer children
 * @param {string} prefix - Path prefix for nested groups
 * @returns {Object[]} Flat array of leaf layers with canvas data
 */
function flattenLayers(layers, prefix = '') {
    const result = [];
    if (!layers) return result;

    for (const layer of layers) {
        if (layer.children && layer.children.length > 0) {
            // Group layer — recurse into all groups (even hidden ones)
            const groupPrefix = prefix ? `${prefix}/${layer.name}` : layer.name;
            result.push(...flattenLayers(layer.children, groupPrefix));
        } else if (layer.canvas) {
            // Leaf layer with canvas pixel data
            result.push({
                name: prefix ? `${prefix}/${layer.name}` : layer.name,
                canvas: layer.canvas,
                left: layer.left || 0,
                top: layer.top || 0,
                width: layer.canvas.width,
                height: layer.canvas.height,
                opacity: layer.opacity !== undefined ? layer.opacity : 1,
                hidden: !!layer.hidden
            });
        } else if (layer.imageData) {
            // Some layers may only have imageData (no canvas)
            // Convert imageData to a canvas
            const canvas = document.createElement('canvas');
            canvas.width = layer.imageData.width;
            canvas.height = layer.imageData.height;
            const ctx = canvas.getContext('2d');
            ctx.putImageData(layer.imageData, 0, 0);
            result.push({
                name: prefix ? `${prefix}/${layer.name}` : layer.name,
                canvas: canvas,
                left: layer.left || 0,
                top: layer.top || 0,
                width: canvas.width,
                height: canvas.height,
                opacity: layer.opacity !== undefined ? layer.opacity : 1,
                hidden: !!layer.hidden
            });
        }
    }

    return result;
}

/**
 * Convert a canvas element to an HTMLImageElement.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<HTMLImageElement>}
 */
function canvasToImage(canvas) {
    return new Promise((resolve, reject) => {
        const dataURL = canvas.toDataURL('image/png');
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to convert layer canvas to image'));
        img.src = dataURL;
    });
}

/**
 * Import a .psd file, parse it, and return an array of image entries
 * compatible with ImageManager.
 *
 * @param {File} file - The .psd File object
 * @param {number} psdWidth - PSD canvas width (used to calculate layer positions)
 * @param {number} psdHeight - PSD canvas height
 * @returns {Promise<Object[]>} Array of image entry objects
 */
export async function importPsd(file) {
    const buffer = await file.arrayBuffer();
    const psd = readPsd(new Uint8Array(buffer));

    const psdWidth = psd.width;
    const psdHeight = psd.height;
    const flatLayers = flattenLayers(psd.children);

    const entries = [];

    for (const layer of flatLayers) {
        const img = await canvasToImage(layer.canvas);

        const entry = {
            id: ++psdIdCounter + Date.now(), // unique ID
            name: layer.name,
            file: null,
            img: img,
            width: layer.width,
            height: layer.height,
            // Position relative to center of PSD canvas
            x: layer.left - psdWidth / 2,
            y: layer.top - psdHeight / 2,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            visible: true,
            opacity: layer.opacity,
            // For slot binding
            slotName: null,
            boneName: null
        };

        entries.push(entry);
    }

    return entries;
}

export default { importPsd };
