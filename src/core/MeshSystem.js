/**
 * MeshSystem — Auto-generates grid meshes over images, computes bone weights,
 * and provides deformed vertex positions for skeletal mesh rendering.
 */
import { bus } from './EventBus.js';

export default class MeshSystem {
    constructor(boneSystem) {
        this.boneSystem = boneSystem;
        this.meshes = new Map(); // imageId -> mesh data

        // Weight preview state
        this.weightPreviewActive = false;
        this.selectedVertexIdx = -1;
        this.selectedMeshId = -1;
        this._draggingVertexIdx = -1;
    }

    /**
     * Auto-generate a grid mesh over an image.
     * Scans alpha channel to skip grid cells in fully transparent areas.
     * @param {object} image - Image entry from ImageManager
     * @param {number} cols - Grid columns (default 4)
     * @param {number} rows - Grid rows (default 6)
     */
    generateMesh(image, cols = 4, rows = 6) {
        // Scan which grid cells contain visible (non-transparent) pixels
        const cellVisible = this._scanCellAlpha(image, cols, rows);

        // Create all grid vertices
        const allVerts = [];
        const allUvs = [];
        const stride = cols + 1;

        for (let r = 0; r <= rows; r++) {
            for (let c = 0; c <= cols; c++) {
                const u = c / cols;
                const v = r / rows;
                allVerts.push({ x: u * image.width, y: v * image.height });
                allUvs.push({ u, v });
            }
        }

        // Collect triangles only for cells with visible pixels
        const rawTriangles = [];
        const usedSet = new Set();

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (!cellVisible[r * cols + c]) continue;

                const tl = r * stride + c;
                const tr = tl + 1;
                const bl = (r + 1) * stride + c;
                const br = bl + 1;

                rawTriangles.push([tl, bl, tr]);
                rawTriangles.push([tr, bl, br]);
                usedSet.add(tl);
                usedSet.add(tr);
                usedSet.add(bl);
                usedSet.add(br);
            }
        }

        // Fallback: if nothing visible, use full rectangle
        if (rawTriangles.length === 0) {
            return this._generateFullRectMesh(image, cols, rows);
        }

        // Remap to only used vertices
        const sortedUsed = Array.from(usedSet).sort((a, b) => a - b);
        const remap = new Map();
        const vertices = [];
        const uvs = [];

        for (let i = 0; i < sortedUsed.length; i++) {
            const old = sortedUsed[i];
            remap.set(old, i);
            vertices.push(allVerts[old]);
            uvs.push(allUvs[old]);
        }

        const triangles = rawTriangles.map(t => t.map(i => remap.get(i)));
        const weights = vertices.map(() => ({}));

        const mesh = {
            imageId: image.id, vertices, uvs, triangles, weights,
            cols, rows, imageWidth: image.width, imageHeight: image.height
        };

        this.meshes.set(image.id, mesh);
        bus.emit('mesh:created', { imageId: image.id });
        return mesh;
    }

    /**
     * Full rectangle mesh (no alpha trimming). Used as fallback.
     */
    _generateFullRectMesh(image, cols, rows) {
        const vertices = [], uvs = [], triangles = [];
        const stride = cols + 1;
        for (let r = 0; r <= rows; r++) {
            for (let c = 0; c <= cols; c++) {
                vertices.push({ x: (c / cols) * image.width, y: (r / rows) * image.height });
                uvs.push({ u: c / cols, v: r / rows });
            }
        }
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const tl = r * stride + c, tr = tl + 1;
                const bl = (r + 1) * stride + c, br = bl + 1;
                triangles.push([tl, bl, tr]);
                triangles.push([tr, bl, br]);
            }
        }
        const weights = vertices.map(() => ({}));
        const mesh = {
            imageId: image.id, vertices, uvs, triangles, weights,
            cols, rows, imageWidth: image.width, imageHeight: image.height
        };
        this.meshes.set(image.id, mesh);
        bus.emit('mesh:created', { imageId: image.id });
        return mesh;
    }

    /**
     * Scan image alpha to determine which grid cells have visible pixels.
     * Returns boolean array: cellVisible[row * cols + col] = true if cell has opaque pixels.
     */
    _scanCellAlpha(image, cols, rows) {
        const img = image.img;
        const total = cols * rows;
        // If no image element, treat all cells as visible
        if (!img) return new Array(total).fill(true);

        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;

        const result = new Array(total).fill(false);

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const x0 = Math.floor((c / cols) * w);
                const y0 = Math.floor((r / rows) * h);
                const x1 = Math.floor(((c + 1) / cols) * w);
                const y1 = Math.floor(((r + 1) / rows) * h);

                // Sample several points in this cell
                const sx = Math.max(1, Math.floor((x1 - x0) / 3));
                const sy = Math.max(1, Math.floor((y1 - y0) / 3));

                let found = false;
                for (let py = y0; py < y1 && !found; py += sy) {
                    for (let px = x0; px < x1 && !found; px += sx) {
                        if (data[(py * w + px) * 4 + 3] > 10) found = true;
                    }
                }
                result[r * cols + c] = found;
            }
        }

        return result;
    }

    /**
     * Auto-compute bone weights using inverse-distance weighting.
     * Also stores bind-pose data for proper skinning.
     * @param {object} mesh - Mesh data
     * @param {object} image - Image entry (for position offset)
     * @param {number} maxBones - Max bones per vertex (default 4)
     * @param {string[]|null} allowedBones - If provided, only these bone names participate in weighting
     */
    autoComputeWeights(mesh, image, maxBones = 4, allowedBones = null) {
        const allBones = this.boneSystem.bones;
        if (allBones.length === 0) return;

        // Filter to only allowed bones if specified
        const bones = allowedBones
            ? allBones.filter(b => allowedBones.includes(b.name))
            : allBones;
        if (bones.length === 0) return;

        // Pre-compute each vertex's world position at bind time
        // boneName is organizational only — always use direct world coords
        const vertexWorldPositions = [];

        for (let vi = 0; vi < mesh.vertices.length; vi++) {
            const vert = mesh.vertices[vi];
            const wx = image.x + vert.x;
            const wy = image.y + vert.y;
            vertexWorldPositions.push({ x: wx, y: wy });

            // Calculate distance to each allowed bone in WORLD space
            const distances = [];
            for (const bone of bones) {
                const bx = bone.worldX;
                const by = bone.worldY;
                let dist;
                if (bone.length > 0) {
                    const boneRad = bone.worldRotation * Math.PI / 180;
                    const ex = bx + Math.cos(boneRad) * bone.length;
                    const ey = by + Math.sin(boneRad) * bone.length;
                    dist = this._pointToSegmentDist(wx, wy, bx, by, ex, ey);
                } else {
                    dist = Math.sqrt((wx - bx) ** 2 + (wy - by) ** 2);
                }
                distances.push({ bone: bone.name, dist: Math.max(dist, 0.1) });
            }

            // Sort by distance, take closest N
            distances.sort((a, b) => a.dist - b.dist);
            const closest = distances.slice(0, maxBones);

            // Inverse-distance weights (1/d^2)
            const rawWeights = closest.map(d => 1 / (d.dist * d.dist));
            const totalWeight = rawWeights.reduce((s, w) => s + w, 0);

            const normalizedWeights = {};
            for (let i = 0; i < closest.length; i++) {
                const w = rawWeights[i] / totalWeight;
                if (w > 0.01) {
                    normalizedWeights[closest[i].bone] = Math.round(w * 1000) / 1000;
                }
            }

            // Re-normalize after filtering
            const sum = Object.values(normalizedWeights).reduce((s, w) => s + w, 0);
            for (const key of Object.keys(normalizedWeights)) {
                normalizedWeights[key] /= sum;
            }

            mesh.weights[vi] = normalizedWeights;
        }

        // Store bind-pose: ALL bone transforms (not just filtered)
        mesh.bindPose = {};
        for (const bone of allBones) {
            mesh.bindPose[bone.name] = {
                worldX: bone.worldX,
                worldY: bone.worldY,
                worldRotation: bone.worldRotation
            };
        }
        mesh.bindVertexWorldPositions = vertexWorldPositions;

        bus.emit('mesh:weights-updated', { imageId: mesh.imageId });
    }

    /**
     * "Bone area" mode — blend weights across ALL bones in the assigned chain.
     * Every vertex gets weighted by all bones in the chain (parent + descendants)
     * using inverse-distance, so the entire chain contributes with smooth blending.
     * No bone limit — all chain bones participate.
     */
    autoComputeWeightsBoneArea(mesh, image, allowedBones = null) {
        const allBones = this.boneSystem.bones;
        if (allBones.length === 0) return;

        const bones = allowedBones
            ? allBones.filter(b => allowedBones.includes(b.name))
            : allBones;
        if (bones.length === 0) return;

        const vertexWorldPositions = [];

        for (let vi = 0; vi < mesh.vertices.length; vi++) {
            const vert = mesh.vertices[vi];
            const wx = image.x + vert.x;
            const wy = image.y + vert.y;
            vertexWorldPositions.push({ x: wx, y: wy });

            // Calculate distance to every bone in the chain
            const rawWeights = {};
            for (const bone of bones) {
                let dist;
                if (bone.length > 0) {
                    const boneRad = bone.worldRotation * Math.PI / 180;
                    const ex = bone.worldX + Math.cos(boneRad) * bone.length;
                    const ey = bone.worldY + Math.sin(boneRad) * bone.length;
                    dist = this._pointToSegmentDist(wx, wy, bone.worldX, bone.worldY, ex, ey);
                } else {
                    dist = Math.sqrt((wx - bone.worldX) ** 2 + (wy - bone.worldY) ** 2);
                }
                dist = Math.max(dist, 0.1);
                // Inverse-distance² — all chain bones contribute
                rawWeights[bone.name] = 1 / (dist * dist);
            }

            // Normalize — every chain bone gets a share
            const sum = Object.values(rawWeights).reduce((s, w) => s + w, 0);
            const normalizedWeights = {};
            for (const [name, w] of Object.entries(rawWeights)) {
                const nw = Math.round((w / sum) * 1000) / 1000;
                if (nw > 0.01) normalizedWeights[name] = nw;
            }
            // Re-normalize after filtering tiny weights
            const sum2 = Object.values(normalizedWeights).reduce((s, w) => s + w, 0);
            for (const key of Object.keys(normalizedWeights)) {
                normalizedWeights[key] /= sum2;
            }

            mesh.weights[vi] = normalizedWeights;
        }

        // Store bind-pose
        mesh.bindPose = {};
        for (const bone of allBones) {
            mesh.bindPose[bone.name] = {
                worldX: bone.worldX,
                worldY: bone.worldY,
                worldRotation: bone.worldRotation
            };
        }
        mesh.bindVertexWorldPositions = vertexWorldPositions;

        bus.emit('mesh:weights-updated', { imageId: mesh.imageId });
    }

    /**
     * Set a specific vertex's weight for a bone. Re-normalizes other weights.
     */
    setVertexWeight(meshId, vertexIdx, boneName, weight) {
        const mesh = this.meshes.get(meshId);
        if (!mesh || vertexIdx < 0 || vertexIdx >= mesh.weights.length) return;

        const w = mesh.weights[vertexIdx];
        weight = Math.max(0, Math.min(1, weight));

        if (weight < 0.01) {
            delete w[boneName];
        } else {
            w[boneName] = weight;
        }

        // Re-normalize remaining weights
        const total = Object.values(w).reduce((s, v) => s + v, 0);
        if (total > 0) {
            for (const key of Object.keys(w)) {
                w[key] /= total;
            }
        }

        bus.emit('mesh:weights-updated', { imageId: meshId });
    }

    /**
     * Get deformed vertex positions using correct Linear Blend Skinning.
     * 
     * For each vertex:
     * 1. Use the stored bind-time world position
     * 2. For each influencing bone, compute the vertex in that bone's bind-pose local space
     * 3. Transform by the bone's CURRENT world transform
     * 4. Weighted average across all bones
     * 
     * This guarantees zero distortion at rest pose (each bone reproduces the same world pos).
     */
    getDeformedVertices(mesh, image) {
        const boneMap = {};
        for (const bone of this.boneSystem.bones) {
            boneMap[bone.name] = bone;
        }

        const bindPose = mesh.bindPose || {};
        const bindVerts = mesh.bindVertexWorldPositions;
        const result = [];

        // Fallback: if no bind vertex data, use world coords directly
        // boneName is organizational only — never apply bone transforms

        for (let vi = 0; vi < mesh.vertices.length; vi++) {
            const vert = mesh.vertices[vi];
            const w = mesh.weights[vi];

            // Get this vertex's world position at bind time
            let vertBindWorldX, vertBindWorldY;
            if (bindVerts && bindVerts[vi]) {
                vertBindWorldX = bindVerts[vi].x;
                vertBindWorldY = bindVerts[vi].y;
            } else {
                // Direct world position — no bone transform (boneName is organizational only)
                vertBindWorldX = image.x + vert.x;
                vertBindWorldY = image.y + vert.y;
            }

            let worldX = 0, worldY = 0;
            let totalW = 0;

            for (const [boneName, weight] of Object.entries(w)) {
                const bone = boneMap[boneName];
                const bp = bindPose[boneName];
                if (!bone || !bp) continue;

                // Step 1: Convert vertex world bind position → this bone's bind-pose LOCAL space
                // inverseBind(p) = rotate(-bindRot, p - bindPos)
                const invRad = -bp.worldRotation * Math.PI / 180;
                const dx = vertBindWorldX - bp.worldX;
                const dy = vertBindWorldY - bp.worldY;
                const boneLocalX = dx * Math.cos(invRad) - dy * Math.sin(invRad);
                const boneLocalY = dx * Math.sin(invRad) + dy * Math.cos(invRad);

                // Step 2: Transform from bone's LOCAL space → CURRENT world space
                const curRad = bone.worldRotation * Math.PI / 180;
                const tx = bone.worldX + boneLocalX * Math.cos(curRad) - boneLocalY * Math.sin(curRad);
                const ty = bone.worldY + boneLocalX * Math.sin(curRad) + boneLocalY * Math.cos(curRad);

                worldX += tx * weight;
                worldY += ty * weight;
                totalW += weight;
            }

            if (totalW > 0) {
                result.push({ x: worldX / totalW, y: worldY / totalW });
            } else {
                // No weights — use bind world position
                result.push({ x: vertBindWorldX, y: vertBindWorldY });
            }
        }

        return result;
    }

    /**
     * Get mesh for an image.
     */
    getMesh(imageId) {
        return this.meshes.get(imageId);
    }

    /**
     * Remove mesh for an image.
     */
    removeMesh(imageId) {
        this.meshes.delete(imageId);
    }

    /**
     * Paint weight for a specific bone at a world position with a brush.
     * Finds all vertices within brushRadius and increases their weight
     * for the specified bone, scaled by distance falloff.
     * @param {number} imageId
     * @param {number} wx - World X of brush center
     * @param {number} wy - World Y of brush center
     * @param {string} boneName - Bone to paint weight for
     * @param {number} brushRadius - Brush radius in world units
     * @param {number} strength - Strength 0-1
     * @param {object} image - Image entry for coordinate transforms
     */
    paintWeight(imageId, wx, wy, boneName, brushRadius, strength, image) {
        const mesh = this.meshes.get(imageId);
        if (!mesh || !mesh.bindVertexWorldPositions) return;

        let changed = false;
        for (let vi = 0; vi < mesh.vertices.length; vi++) {
            const vw = mesh.bindVertexWorldPositions[vi];
            if (!vw) continue;

            const dx = wx - vw.x;
            const dy = wy - vw.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > brushRadius) continue;

            // Distance falloff (1 at center, 0 at edge)
            const falloff = 1 - (dist / brushRadius);
            const delta = strength * falloff * 0.1; // Scale down to prevent instant 100%

            const w = mesh.weights[vi];

            // Increase weight for this bone
            const current = w[boneName] || 0;
            w[boneName] = Math.min(1, current + delta);

            // Re-normalize all weights
            const total = Object.values(w).reduce((s, v) => s + v, 0);
            if (total > 0) {
                for (const key of Object.keys(w)) {
                    w[key] /= total;
                }
            }
            changed = true;
        }

        if (changed) {
            bus.emit('mesh:weights-updated', { imageId });
        }
    }

    /**
     * Move a vertex to a new position (relative to image origin).
     * Also updates the bind vertex world position.
     */
    moveVertex(meshId, vertexIdx, newX, newY, image) {
        const mesh = this.meshes.get(meshId);
        if (!mesh || vertexIdx < 0 || vertexIdx >= mesh.vertices.length) return;

        mesh.vertices[vertexIdx].x = newX;
        mesh.vertices[vertexIdx].y = newY;

        // Also update the UV based on new position and image size
        mesh.uvs[vertexIdx].u = newX / mesh.imageWidth;
        mesh.uvs[vertexIdx].v = newY / mesh.imageHeight;

        // Update bind vertex world position
        if (mesh.bindVertexWorldPositions && image) {
            const localX = image.x + newX;
            const localY = image.y + newY;
            const primaryBone = image.boneName ? this.boneSystem.getBoneByName(image.boneName) : null;
            if (primaryBone) {
                const rad = primaryBone.worldRotation * Math.PI / 180;
                mesh.bindVertexWorldPositions[vertexIdx] = {
                    x: primaryBone.worldX + localX * Math.cos(rad) - localY * Math.sin(rad),
                    y: primaryBone.worldY + localX * Math.sin(rad) + localY * Math.cos(rad)
                };
            } else {
                mesh.bindVertexWorldPositions[vertexIdx] = { x: localX, y: localY };
            }
        }

        bus.emit('mesh:vertex-moved', { meshId, vertexIdx });
    }

    // ========== WEIGHT PREVIEW ==========

    /**
     * Enter weight preview mode for a mesh.
     */
    startWeightPreview(imageId) {
        this.weightPreviewActive = true;
        this.selectedMeshId = imageId;
        this.selectedVertexIdx = -1;
        bus.emit('mesh:weight-preview', true);
    }

    cancelWeightPreview() {
        this.weightPreviewActive = false;
        this.selectedMeshId = -1;
        this.selectedVertexIdx = -1;
        bus.emit('mesh:weight-preview', false);
    }

    /**
     * Hit-test a vertex in weight preview mode.
     */
    hitTestVertex(wx, wy, image, zoom) {
        const mesh = this.meshes.get(this.selectedMeshId);
        if (!mesh || !image) return -1;

        const hitR = 10 / zoom;
        let best = -1, bestDist = Infinity;

        for (let i = 0; i < mesh.vertices.length; i++) {
            const v = mesh.vertices[i];
            // Vertex in world coords (bone-transformed)
            const bone = image.boneName ? this.boneSystem.getBoneByName(image.boneName) : null;
            let vx, vy;
            if (bone) {
                const rad = bone.worldRotation * Math.PI / 180;
                vx = bone.worldX + (image.x + v.x) * Math.cos(rad) - (image.y + v.y) * Math.sin(rad);
                vy = bone.worldY + (image.x + v.x) * Math.sin(rad) + (image.y + v.y) * Math.cos(rad);
            } else {
                vx = image.x + v.x;
                vy = image.y + v.y;
            }

            const d = Math.sqrt((wx - vx) ** 2 + (wy - vy) ** 2);
            if (d < hitR && d < bestDist) {
                bestDist = d;
                best = i;
            }
        }
        return best;
    }

    /**
     * Render weight preview overlay.
     */
    renderWeightPreview(ctx, viewport, image) {
        if (!this.weightPreviewActive || !image) return;
        const mesh = this.meshes.get(this.selectedMeshId);
        if (!mesh) return;

        const zoom = viewport.camera.zoom;

        ctx.save();

        // boneName is organizational only — no bone transform applied

        // Get bone color map
        const boneColors = {};
        for (const b of this.boneSystem.bones) {
            boneColors[b.name] = b.color || '#c8d850';
        }

        // Draw triangles wireframe
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1 / zoom;
        for (const [a, b, c] of mesh.triangles) {
            const va = mesh.vertices[a], vb = mesh.vertices[b], vc = mesh.vertices[c];
            ctx.beginPath();
            ctx.moveTo(image.x + va.x, image.y + va.y);
            ctx.lineTo(image.x + vb.x, image.y + vb.y);
            ctx.lineTo(image.x + vc.x, image.y + vc.y);
            ctx.closePath();
            ctx.stroke();
        }

        // Draw filled triangles with weight colors (semi-transparent)
        for (const [a, b, c] of mesh.triangles) {
            const va = mesh.vertices[a], vb = mesh.vertices[b], vc = mesh.vertices[c];

            // Average weight color for this triangle
            const avgWeights = {};
            for (const idx of [a, b, c]) {
                for (const [bn, w] of Object.entries(mesh.weights[idx])) {
                    avgWeights[bn] = (avgWeights[bn] || 0) + w / 3;
                }
            }

            // Get dominant bone color
            let maxW = 0, domColor = '#c8d850';
            for (const [bn, w] of Object.entries(avgWeights)) {
                if (w > maxW) {
                    maxW = w;
                    domColor = boneColors[bn] || '#c8d850';
                }
            }

            ctx.globalAlpha = 0.15;
            ctx.fillStyle = domColor;
            ctx.beginPath();
            ctx.moveTo(image.x + va.x, image.y + va.y);
            ctx.lineTo(image.x + vb.x, image.y + vb.y);
            ctx.lineTo(image.x + vc.x, image.y + vc.y);
            ctx.closePath();
            ctx.fill();
        }

        // Draw vertices
        const dotR = 5 / zoom;
        for (let i = 0; i < mesh.vertices.length; i++) {
            const v = mesh.vertices[i];
            const vx = image.x + v.x;
            const vy = image.y + v.y;
            const w = mesh.weights[i];

            // Dominant bone color
            let maxW = 0, color = '#c8d850';
            for (const [bn, wt] of Object.entries(w)) {
                if (wt > maxW) {
                    maxW = wt;
                    color = boneColors[bn] || '#c8d850';
                }
            }

            const isSelected = (i === this.selectedVertexIdx);
            ctx.globalAlpha = isSelected ? 1.0 : 0.8;

            // Selected vertex ring
            if (isSelected) {
                ctx.beginPath();
                ctx.arc(vx, vy, dotR * 2.5, 0, Math.PI * 2);
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2 / zoom;
                ctx.setLineDash([3 / zoom, 2 / zoom]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Vertex dot
            ctx.beginPath();
            ctx.arc(vx, vy, isSelected ? dotR * 1.5 : dotR, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5 / zoom;
            ctx.stroke();
        }

        ctx.globalAlpha = 1;
        ctx.restore();
    }

    /**
     * Render an image as a deformed mesh using per-triangle affine texture mapping.
     * This is the main render path — images with meshes use this instead of simple drawImage.
     * Called from the render pipeline where the camera transform is already applied.
     * @param {CanvasRenderingContext2D} ctx - Context with camera transform already applied
     * @param {object} image - Image entry from ImageManager
     * @returns {boolean} true if mesh was rendered, false if no mesh exists
     */
    renderMeshDeformed(ctx, image) {
        const mesh = this.meshes.get(image.id);
        if (!mesh) return false;

        // Check if mesh has any weights assigned
        const hasWeights = mesh.weights.some(w => Object.keys(w).length > 0);
        if (!hasWeights) return false;

        // Get deformed vertex positions in world space
        const deformed = this.getDeformedVertices(mesh, image);

        ctx.save();
        ctx.globalAlpha = image.opacity;

        // Draw each triangle with textured fill
        for (const [ai, bi, ci] of mesh.triangles) {
            const pa = deformed[ai], pb = deformed[bi], pc = deformed[ci];
            const ua = mesh.uvs[ai], ub = mesh.uvs[bi], uc = mesh.uvs[ci];

            // Source triangle (in texture pixel coords)
            const sx0 = ua.u * mesh.imageWidth, sy0 = ua.v * mesh.imageHeight;
            const sx1 = ub.u * mesh.imageWidth, sy1 = ub.v * mesh.imageHeight;
            const sx2 = uc.u * mesh.imageWidth, sy2 = uc.v * mesh.imageHeight;

            // Destination triangle (in world coords, already deformed)
            const dx0 = pa.x, dy0 = pa.y;
            const dx1 = pb.x, dy1 = pb.y;
            const dx2 = pc.x, dy2 = pc.y;

            // Compute affine transform: source → dest in world space
            // M * [sx, sy, 1]^T = [dx, dy]^T
            const denom = (sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1));
            if (Math.abs(denom) < 0.001) continue; // Degenerate triangle

            const ma = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom;
            const mb = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / denom;
            const mc = (dx0 * (sx1 * sy2 - sx2 * sy1) + dx1 * (sx2 * sy0 - sx0 * sy2) + dx2 * (sx0 * sy1 - sx1 * sy0)) / denom;
            const md = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom;
            const me = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / denom;
            const mf = (dy0 * (sx1 * sy2 - sx2 * sy1) + dy1 * (sx2 * sy0 - sx0 * sy2) + dy2 * (sx0 * sy1 - sx1 * sy0)) / denom;

            ctx.save();

            // Clip to the destination triangle (in world coords — camera transform handles screen mapping)
            ctx.beginPath();
            ctx.moveTo(dx0, dy0);
            ctx.lineTo(dx1, dy1);
            ctx.lineTo(dx2, dy2);
            ctx.closePath();
            ctx.clip();

            // Apply the affine transform (texture space → world space)
            // The existing camera transform on the context will then map world → screen
            ctx.transform(ma, md, mb, me, mc, mf);
            ctx.drawImage(image.img, 0, 0);

            ctx.restore();
        }

        ctx.restore();
        return true;
    }

    // ========== HELPERS ==========

    _pointToSegmentDist(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
        let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const projX = ax + t * dx, projY = ay + t * dy;
        return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
    }

    // ========== SERIALIZATION ==========

    toJSON() {
        const result = {};
        for (const [id, mesh] of this.meshes) {
            result[id] = {
                vertices: mesh.vertices,
                uvs: mesh.uvs,
                triangles: mesh.triangles,
                weights: mesh.weights,
                cols: mesh.cols,
                rows: mesh.rows,
                imageWidth: mesh.imageWidth,
                imageHeight: mesh.imageHeight
            };
        }
        return result;
    }

    fromJSON(data) {
        this.meshes.clear();
        for (const [id, mesh] of Object.entries(data)) {
            mesh.imageId = parseInt(id);
            this.meshes.set(mesh.imageId, mesh);
        }
    }
}
