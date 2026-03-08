/**
 * AutoRigger — Uses MediaPipe PoseLandmarker to detect body pose from a sprite
 * image, then auto-creates a bone hierarchy matching the detected pose.
 * Supports a preview phase where landmarks are shown before bones are created.
 */
import { bus } from './EventBus.js';

// MediaPipe landmark indices
const LM = {
    NOSE: 0,
    LEFT_EYE_INNER: 1, LEFT_EYE: 2, LEFT_EYE_OUTER: 3,
    RIGHT_EYE_INNER: 4, RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6,
    LEFT_EAR: 7, RIGHT_EAR: 8,
    MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
    LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
    LEFT_WRIST: 15, RIGHT_WRIST: 16,
    LEFT_PINKY: 17, RIGHT_PINKY: 18,
    LEFT_INDEX: 19, RIGHT_INDEX: 20,
    LEFT_THUMB: 21, RIGHT_THUMB: 22,
    LEFT_HIP: 23, RIGHT_HIP: 24,
    LEFT_KNEE: 25, RIGHT_KNEE: 26,
    LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
    LEFT_HEEL: 29, RIGHT_HEEL: 30,
    LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32
};

// Pose connections for drawing skeleton lines
const POSE_CONNECTIONS = [
    [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER],
    [LM.LEFT_HIP, LM.RIGHT_HIP],
    // Torso
    [LM.LEFT_SHOULDER, LM.LEFT_HIP],
    [LM.RIGHT_SHOULDER, LM.RIGHT_HIP],
    // Head
    [LM.LEFT_SHOULDER, LM.LEFT_EAR],
    [LM.RIGHT_SHOULDER, LM.RIGHT_EAR],
    [LM.LEFT_EAR, LM.NOSE],
    [LM.RIGHT_EAR, LM.NOSE],
    // Left arm
    [LM.LEFT_SHOULDER, LM.LEFT_ELBOW],
    [LM.LEFT_ELBOW, LM.LEFT_WRIST],
    [LM.LEFT_WRIST, LM.LEFT_INDEX],
    [LM.LEFT_WRIST, LM.LEFT_PINKY],
    [LM.LEFT_WRIST, LM.LEFT_THUMB],
    // Right arm
    [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW],
    [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
    [LM.RIGHT_WRIST, LM.RIGHT_INDEX],
    [LM.RIGHT_WRIST, LM.RIGHT_PINKY],
    [LM.RIGHT_WRIST, LM.RIGHT_THUMB],
    // Left leg
    [LM.LEFT_HIP, LM.LEFT_KNEE],
    [LM.LEFT_KNEE, LM.LEFT_ANKLE],
    [LM.LEFT_ANKLE, LM.LEFT_FOOT_INDEX],
    [LM.LEFT_ANKLE, LM.LEFT_HEEL],
    // Right leg
    [LM.RIGHT_HIP, LM.RIGHT_KNEE],
    [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
    [LM.RIGHT_ANKLE, LM.RIGHT_FOOT_INDEX],
    [LM.RIGHT_ANKLE, LM.RIGHT_HEEL],
];

// Bone hierarchy definition
const BONE_MAP = [
    { name: 'root', parent: null, from: [LM.LEFT_HIP, LM.RIGHT_HIP], to: [LM.LEFT_HIP, LM.RIGHT_HIP] },
    { name: 'spine', parent: 'root', from: [LM.LEFT_HIP, LM.RIGHT_HIP], to: [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER] },
    { name: 'neck', parent: 'spine', from: [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER], to: [LM.LEFT_EAR, LM.RIGHT_EAR] },
    { name: 'head', parent: 'neck', from: [LM.LEFT_EAR, LM.RIGHT_EAR], to: LM.NOSE },

    { name: 'left_upper_arm', parent: 'spine', from: LM.LEFT_SHOULDER, to: LM.LEFT_ELBOW },
    { name: 'left_forearm', parent: 'left_upper_arm', from: LM.LEFT_ELBOW, to: LM.LEFT_WRIST },
    { name: 'left_hand', parent: 'left_forearm', from: LM.LEFT_WRIST, to: LM.LEFT_INDEX },

    { name: 'right_upper_arm', parent: 'spine', from: LM.RIGHT_SHOULDER, to: LM.RIGHT_ELBOW },
    { name: 'right_forearm', parent: 'right_upper_arm', from: LM.RIGHT_ELBOW, to: LM.RIGHT_WRIST },
    { name: 'right_hand', parent: 'right_forearm', from: LM.RIGHT_WRIST, to: LM.RIGHT_INDEX },

    { name: 'left_thigh', parent: 'root', from: LM.LEFT_HIP, to: LM.LEFT_KNEE },
    { name: 'left_shin', parent: 'left_thigh', from: LM.LEFT_KNEE, to: LM.LEFT_ANKLE },
    { name: 'left_foot', parent: 'left_shin', from: LM.LEFT_ANKLE, to: LM.LEFT_FOOT_INDEX },

    { name: 'right_thigh', parent: 'root', from: LM.RIGHT_HIP, to: LM.RIGHT_KNEE },
    { name: 'right_shin', parent: 'right_thigh', from: LM.RIGHT_KNEE, to: LM.RIGHT_ANKLE },
    { name: 'right_foot', parent: 'right_shin', from: LM.RIGHT_ANKLE, to: LM.RIGHT_FOOT_INDEX },
];

// Landmark labels for the important joints
const LANDMARK_LABELS = {
    [LM.NOSE]: 'Head',
    [LM.LEFT_SHOULDER]: 'L.Shoulder',
    [LM.RIGHT_SHOULDER]: 'R.Shoulder',
    [LM.LEFT_ELBOW]: 'L.Elbow',
    [LM.RIGHT_ELBOW]: 'R.Elbow',
    [LM.LEFT_WRIST]: 'L.Wrist',
    [LM.RIGHT_WRIST]: 'R.Wrist',
    [LM.LEFT_HIP]: 'L.Hip',
    [LM.RIGHT_HIP]: 'R.Hip',
    [LM.LEFT_KNEE]: 'L.Knee',
    [LM.RIGHT_KNEE]: 'R.Knee',
    [LM.LEFT_ANKLE]: 'L.Ankle',
    [LM.RIGHT_ANKLE]: 'R.Ankle',
};

// Bone group colors — same tone per group, dark → light along chain
const BONE_GROUP_COLORS = {
    // Center / Spine — green
    'root': '#2d8a4e',
    'spine': '#3da862',
    'neck': '#5cc87c',
    'head': '#7ee89a',

    // Left arm — cyan
    'left_upper_arm': '#1a7a8a',
    'left_forearm': '#28a0b4',
    'left_hand': '#45c8dc',

    // Right arm — pink/magenta
    'right_upper_arm': '#8a1a6a',
    'right_forearm': '#b428a0',
    'right_hand': '#dc45c0',

    // Left leg — blue
    'left_thigh': '#1a4a8a',
    'left_shin': '#2868b4',
    'left_foot': '#4590dc',

    // Right leg — purple
    'right_thigh': '#5a1a8a',
    'right_shin': '#7828b4',
    'right_foot': '#9a45dc',
};

export default class AutoRigger {
    constructor(boneSystem) {
        this.boneSystem = boneSystem;
        this._poseLandmarker = null;
        this._loading = false;

        // Preview state
        this.previewActive = false;
        this.previewLandmarks = null;
        this.previewImage = null;

        // Landmark drag state
        this._draggingLandmarkIdx = -1;
        this.selectedLandmarkIdx = -1;
    }

    /**
     * Check if WebGL is available in this browser.
     */
    _hasWebGL() {
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            return !!gl;
        } catch (e) {
            return false;
        }
    }

    /**
     * Load MediaPipe PoseLandmarker from CDN (lazy, first-time only).
     */
    async _ensureLoaded() {
        if (this._poseLandmarker) return;
        if (this._loading) throw new Error('Already loading MediaPipe');

        this._loading = true;
        bus.emit('toast', { message: 'Loading MediaPipe pose model…', type: 'info' });

        try {
            const vision = await import(
                /* @vite-ignore */
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm'
            );

            const { PoseLandmarker, FilesetResolver } = vision;

            const filesetResolver = await FilesetResolver.forVisionTasks(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
            );

            // Always use CPU delegate — MediaPipe's WASM WebGL context creation
            // crashes the tab even when the browser supports WebGL.
            // CPU is fast enough for single-image pose detection.
            this._poseLandmarker = await PoseLandmarker.createFromOptions(
                filesetResolver,
                {
                    baseOptions: {
                        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
                        delegate: 'CPU'
                    },
                    runningMode: 'IMAGE',
                    numPoses: 1
                }
            );

            bus.emit('toast', { message: 'MediaPipe loaded ✓', type: 'success' });
        } catch (err) {
            console.error('Failed to load MediaPipe:', err);
            bus.emit('toast', { message: 'Failed to load MediaPipe: ' + err.message, type: 'error' });
            throw err;
        } finally {
            this._loading = false;
        }
    }

    /**
     * Convert landmark index to world coords.
     */
    _landmarkToWorld(landmarks, index, image) {
        let nx, ny;
        if (Array.isArray(index)) {
            const a = landmarks[index[0]];
            const b = landmarks[index[1]];
            nx = (a.x + b.x) / 2;
            ny = (a.y + b.y) / 2;
        } else {
            nx = landmarks[index].x;
            ny = landmarks[index].y;
        }
        const wx = image.x + nx * image.width;
        const wy = image.y + ny * image.height;
        return { x: wx, y: wy };
    }

    // ========== PREVIEW PHASE ==========

    /**
     * Detect pose and enter preview mode (landmarks shown, no bones yet).
     * Composites ALL visible images for detection.
     * @param {Object} imageManager - ImageManager instance with all images
     * @returns {boolean} true if a pose was found
     */
    async detectAndPreview(imageManager) {
        await this._ensureLoaded();

        const images = imageManager.images.filter(i => i.visible);
        if (images.length === 0) {
            bus.emit('toast', { message: 'No visible images to detect pose', type: 'warning' });
            return false;
        }

        bus.emit('toast', { message: 'Detecting pose…', type: 'info' });

        // Compute bounding box of all visible images
        // Use original (pre-trim) bounds if available for consistent compositing
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const img of images) {
            const ob = img._originalBounds;
            if (ob) {
                // Use original bounds to maintain consistent canvas size
                minX = Math.min(minX, ob.x);
                minY = Math.min(minY, ob.y);
                maxX = Math.max(maxX, ob.x + ob.width * img.scaleX);
                maxY = Math.max(maxY, ob.y + ob.height * img.scaleY);
            } else {
                minX = Math.min(minX, img.x);
                minY = Math.min(minY, img.y);
                maxX = Math.max(maxX, img.x + img.width * img.scaleX);
                maxY = Math.max(maxY, img.y + img.height * img.scaleY);
            }
        }
        const compositeW = Math.ceil(maxX - minX);
        const compositeH = Math.ceil(maxY - minY);

        // Composite all visible images onto one offscreen canvas
        const offCanvas = document.createElement('canvas');
        offCanvas.width = compositeW;
        offCanvas.height = compositeH;
        const offCtx = offCanvas.getContext('2d');

        for (const img of images) {
            offCtx.save();
            offCtx.globalAlpha = img.opacity;
            const dx = img.x - minX;
            const dy = img.y - minY;
            offCtx.drawImage(img.img, dx, dy, img.width * img.scaleX, img.height * img.scaleY);
            offCtx.restore();
        }

        const result = this._poseLandmarker.detect(offCanvas);

        if (!result.landmarks || result.landmarks.length === 0) {
            bus.emit('toast', { message: 'No pose detected in image', type: 'warning' });
            return false;
        }

        // Store preview data — use a virtual image bounds for coordinate mapping
        this.previewLandmarks = result.landmarks[0];
        this.previewImage = {
            x: minX,
            y: minY,
            width: compositeW,
            height: compositeH,
        };
        this.previewActive = true;

        bus.emit('toast', { message: 'Pose detected! Review and click Apply or press Enter', type: 'success' });
        bus.emit('autorig:preview', true);
        return true;
    }

    /**
     * Cancel the preview — clear stored landmarks.
     */
    cancelPreview() {
        this.previewActive = false;
        this.previewLandmarks = null;
        this.previewImage = null;
        this._draggingLandmarkIdx = -1;
        this.selectedLandmarkIdx = -1;
        bus.emit('autorig:preview', false);
    }

    // ========== LANDMARK EDITING ==========

    /**
     * Hit-test: find which landmark is near (wx, wy) in world coords.
     * Returns landmark index or -1.
     */
    hitTestLandmark(wx, wy, zoom) {
        if (!this.previewActive || !this.previewLandmarks) return -1;

        const hitRadius = 12 / zoom; // screen-consistent hit size
        let bestIdx = -1;
        let bestDist = Infinity;

        for (let i = 0; i < this.previewLandmarks.length; i++) {
            const lm = this.previewLandmarks[i];
            if (lm.visibility < 0.2) continue;

            const wp = this._landmarkToWorld(this.previewLandmarks, i, this.previewImage);
            const dx = wp.x - wx;
            const dy = wp.y - wy;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < hitRadius && dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    /**
     * Begin dragging a landmark.
     */
    startDragLandmark(wx, wy, zoom) {
        const idx = this.hitTestLandmark(wx, wy, zoom);
        if (idx >= 0) {
            this._draggingLandmarkIdx = idx;
            this.selectedLandmarkIdx = idx;
            return true;
        }
        return false;
    }

    /**
     * Drag landmark to new world position — updates normalized coords.
     */
    dragLandmark(wx, wy) {
        if (this._draggingLandmarkIdx < 0 || !this.previewLandmarks || !this.previewImage) return;

        const image = this.previewImage;
        const lm = this.previewLandmarks[this._draggingLandmarkIdx];

        // Convert world coords back to normalized (0-1)
        lm.x = (wx - image.x) / image.width;
        lm.y = (wy - image.y) / image.height;
    }

    /**
     * End landmark drag.
     */
    endDragLandmark() {
        this._draggingLandmarkIdx = -1;
    }

    /** Is currently dragging a landmark? */
    get isDraggingLandmark() {
        return this._draggingLandmarkIdx >= 0;
    }

    /**
     * Apply the preview — create bones from stored landmarks.
     */
    applyPreview() {
        if (!this.previewActive || !this.previewLandmarks || !this.previewImage) return null;

        const landmarks = this.previewLandmarks;
        const image = this.previewImage;

        // Clear existing bones
        while (this.boneSystem.bones.length > 0) {
            this.boneSystem.removeBone(this.boneSystem.bones[0]);
        }

        const createdBones = {};

        for (const def of BONE_MAP) {
            const fromPos = this._landmarkToWorld(landmarks, def.from, image);
            const toPos = this._landmarkToWorld(landmarks, def.to, image);

            if (def.name === 'root') {
                const bone = this.boneSystem.addBone(def.name, null, {
                    x: fromPos.x,
                    y: fromPos.y,
                    rotation: 0,
                    length: 0,
                    color: BONE_GROUP_COLORS[def.name] || '#c8d850'
                });
                createdBones[def.name] = bone;
                continue;
            }

            const parentBone = createdBones[def.parent];
            if (!parentBone) continue;

            const dx = toPos.x - fromPos.x;
            const dy = toPos.y - fromPos.y;
            const length = Math.sqrt(dx * dx + dy * dy);
            const worldAngle = Math.atan2(dy, dx) * 180 / Math.PI;

            // BoneSystem._computeWorld positions children at the parent bone's END
            // (parentWorldX + cos(rot)*length, parentWorldY + sin(rot)*length).
            // So local offset must be relative to the parent's END, not its start.
            const pWorldRad = parentBone.worldRotation * Math.PI / 180;
            const parentEndX = parentBone.worldX + Math.cos(pWorldRad) * parentBone.length;
            const parentEndY = parentBone.worldY + Math.sin(pWorldRad) * parentBone.length;

            const offsetX = fromPos.x - parentEndX;
            const offsetY = fromPos.y - parentEndY;

            // Rotate into parent's local space (inverse of parent world rotation)
            const invRad = -parentBone.worldRotation * Math.PI / 180;
            const lx = offsetX * Math.cos(invRad) - offsetY * Math.sin(invRad);
            const ly = offsetX * Math.sin(invRad) + offsetY * Math.cos(invRad);

            // Local rotation = world angle minus parent's world rotation
            const localRotation = worldAngle - parentBone.worldRotation;

            const bone = this.boneSystem.addBone(def.name, parentBone, {
                x: lx,
                y: ly,
                rotation: localRotation,
                length: Math.round(length * 100) / 100,
                color: BONE_GROUP_COLORS[def.name] || '#c8d850'
            });
            createdBones[def.name] = bone;
        }

        this.boneSystem.updateWorldTransforms();

        // End preview
        this.previewActive = false;
        this.previewLandmarks = null;
        this.previewImage = null;

        bus.emit('toast', { message: `Auto-rigged: ${Object.keys(createdBones).length} bones created`, type: 'success' });
        bus.emit('autorig:preview', false);
        bus.emit('bones:changed');

        return createdBones;
    }

    // ========== RENDER OVERLAY ==========

    /**
     * Render the preview landmarks on the viewport canvas.
     * Call this from the render pipeline when previewActive is true.
     */
    renderPreview(ctx, viewport) {
        if (!this.previewActive || !this.previewLandmarks || !this.previewImage) return;

        const landmarks = this.previewLandmarks;
        const image = this.previewImage;
        const zoom = viewport.camera.zoom;

        ctx.save();

        // Draw connection lines (skeleton) — world coordinates
        ctx.lineWidth = 3 / zoom;
        ctx.lineCap = 'round';
        for (const [a, b] of POSE_CONNECTIONS) {
            const ptA = this._landmarkToWorld(landmarks, a, image);
            const ptB = this._landmarkToWorld(landmarks, b, image);

            // Color: left side = cyan, right side = pink, center = green
            let color;
            const isLeft = (a % 2 === 1 && a >= 11) || (b % 2 === 1 && b >= 11);
            const isRight = (a % 2 === 0 && a >= 12) || (b % 2 === 0 && b >= 12);
            if (isLeft && !isRight) {
                color = '#60b4d3';
            } else if (isRight && !isLeft) {
                color = '#d360b4';
            } else {
                color = '#4ade80';
            }

            // Shadow
            ctx.strokeStyle = 'rgba(0,0,0,0.4)';
            ctx.lineWidth = 5 / zoom;
            ctx.beginPath();
            ctx.moveTo(ptA.x, ptA.y);
            ctx.lineTo(ptB.x, ptB.y);
            ctx.stroke();

            // Line
            ctx.strokeStyle = color;
            ctx.lineWidth = 3 / zoom;
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.moveTo(ptA.x, ptA.y);
            ctx.lineTo(ptB.x, ptB.y);
            ctx.stroke();
        }

        // Draw landmark dots
        const dotR = 6 / zoom;
        for (let i = 0; i < landmarks.length; i++) {
            const lm = landmarks[i];
            if (lm.visibility < 0.3) continue;

            const wp = this._landmarkToWorld(landmarks, i, image);
            const isKey = LANDMARK_LABELS[i] !== undefined;
            const isSelected = (i === this.selectedLandmarkIdx);
            const isDragging = (i === this._draggingLandmarkIdx);

            const r = isKey ? dotR * 1.3 : dotR * 0.8;

            // Fill color
            let fill;
            if (i === LM.NOSE) fill = '#fbbf24';
            else if (i <= 10) fill = '#4ade80';
            else if (i % 2 === 1) fill = '#60b4d3';
            else fill = '#d360b4';

            ctx.globalAlpha = isKey ? 1.0 : 0.7;

            // Selected/dragging glow
            if (isSelected || isDragging) {
                ctx.globalAlpha = 1.0;
                ctx.beginPath();
                ctx.arc(wp.x, wp.y, r * 2.5, 0, Math.PI * 2);
                ctx.fillStyle = fill.replace(')', ', 0.2)').replace('rgb', 'rgba').replace('#', '');
                ctx.strokeStyle = fill;
                ctx.lineWidth = 2 / zoom;
                // Glow ring
                ctx.beginPath();
                ctx.arc(wp.x, wp.y, r * 2, 0, Math.PI * 2);
                ctx.strokeStyle = fill;
                ctx.lineWidth = 2.5 / zoom;
                ctx.setLineDash([4 / zoom, 3 / zoom]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Shadow ring
            ctx.beginPath();
            ctx.arc(wp.x, wp.y, r + 2 / zoom, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fill();

            // Dot
            ctx.beginPath();
            ctx.arc(wp.x, wp.y, isSelected ? r * 1.4 : r, 0, Math.PI * 2);
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.strokeStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.7)';
            ctx.lineWidth = (isSelected ? 2.5 : 1.5) / zoom;
            ctx.stroke();

            // Label
            if (isKey) {
                ctx.globalAlpha = 0.9;
                const fontSize = Math.max(10, 12 / zoom);
                ctx.font = `600 ${fontSize}px "Inter", sans-serif`;
                ctx.fillStyle = '#fff';
                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.lineWidth = 3 / zoom;
                ctx.textAlign = 'left';
                const tx = wp.x + dotR * 2.5;
                const ty = wp.y + fontSize * 0.35;
                ctx.strokeText(LANDMARK_LABELS[i], tx, ty);
                ctx.fillText(LANDMARK_LABELS[i], tx, ty);
            }
        }

        ctx.globalAlpha = 1;
        ctx.restore();
    }
}

export { BONE_MAP, LM, POSE_CONNECTIONS };
