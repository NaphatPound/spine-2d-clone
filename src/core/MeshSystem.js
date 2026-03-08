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
     * @param {object} image - Image entry from ImageManager
     * @param {number} cols - Grid columns (default 4)
     * @param {number} rows - Grid rows (default 6)
     */
    generateMesh(image, cols = 4, rows = 6) {
        const vertices = [];
        const uvs = [];
        const triangles = [];

        // Create grid vertices
        for (let r = 0; r <= rows; r++) {
            for (let c = 0; c <= cols; c++) {
                const u = c / cols;
                const v = r / rows;
                // Local position relative to image origin
                const x = u * image.width;
                const y = v * image.height;
                vertices.push({ x, y });
                uvs.push({ u, v });
            }
        }

        // Create triangles (two per grid cell)
        const stride = cols + 1;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const tl = r * stride + c;
                const tr = tl + 1;
                const bl = (r + 1) * stride + c;
                const br = bl + 1;
                triangles.push([tl, bl, tr]);
                triangles.push([tr, bl, br]);
            }
        }

        // Initialize empty bone weights
        const weights = vertices.map(() => ({})); // { boneName: weight }

        const mesh = {
            imageId: image.id,
            vertices,
            uvs,
            triangles,
            weights,
            cols,
            rows,
            imageWidth: image.width,
            imageHeight: image.height
        };

        this.meshes.set(image.id, mesh);
        bus.emit('mesh:created', { imageId: image.id });
        return mesh;
    }

    /**
     * Auto-compute bone weights using inverse-distance weighting.
     * Also stores bind-pose data for proper skinning.
     * @param {object} mesh - Mesh data
     * @param {object} image - Image entry (for position offset)
     * @param {number} maxBones - Max bones per vertex (default 4)
     */
    autoComputeWeights(mesh, image, maxBones = 4) {
        const bones = this.boneSystem.bones;
        if (bones.length === 0) return;

        // Get the image's primary bone for coordinate transforms
        const primaryBone = image.boneName ? this.boneSystem.getBoneByName(image.boneName) : null;

        // Pre-compute each vertex's world position at bind time
        const vertexWorldPositions = [];

        for (let vi = 0; vi < mesh.vertices.length; vi++) {
            const vert = mesh.vertices[vi];
            const localX = image.x + vert.x;
            const localY = image.y + vert.y;

            let wx, wy;
            if (primaryBone) {
                // Transform from image-local (bone-local) to world space
                const rad = primaryBone.worldRotation * Math.PI / 180;
                wx = primaryBone.worldX + localX * Math.cos(rad) - localY * Math.sin(rad);
                wy = primaryBone.worldY + localX * Math.sin(rad) + localY * Math.cos(rad);
            } else {
                wx = localX;
                wy = localY;
            }
            vertexWorldPositions.push({ x: wx, y: wy });

            // Calculate distance to each bone in WORLD space
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

        // Store bind-pose: bone transforms + vertex world positions
        mesh.bindPose = {};
        for (const bone of bones) {
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

        // Fallback: if no bind vertex data, compute world positions from primary bone
        const primaryBone = image.boneName ? boneMap[image.boneName] : null;

        for (let vi = 0; vi < mesh.vertices.length; vi++) {
            const vert = mesh.vertices[vi];
            const w = mesh.weights[vi];

            // Get this vertex's world position at bind time
            let vertBindWorldX, vertBindWorldY;
            if (bindVerts && bindVerts[vi]) {
                vertBindWorldX = bindVerts[vi].x;
                vertBindWorldY = bindVerts[vi].y;
            } else {
                // Fallback: compute from primary bone
                const localX = image.x + vert.x;
                const localY = image.y + vert.y;
                if (primaryBone) {
                    const rad = primaryBone.worldRotation * Math.PI / 180;
                    vertBindWorldX = primaryBone.worldX + localX * Math.cos(rad) - localY * Math.sin(rad);
                    vertBindWorldY = primaryBone.worldY + localX * Math.sin(rad) + localY * Math.cos(rad);
                } else {
                    vertBindWorldX = localX;
                    vertBindWorldY = localY;
                }
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
        const bone = image.boneName ? this.boneSystem.getBoneByName(image.boneName) : null;

        ctx.save();

        // Apply bone transform if bound
        if (bone) {
            ctx.translate(bone.worldX, bone.worldY);
            ctx.rotate(bone.worldRotation * Math.PI / 180);
        }

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
