/**
 * AnimationSystem — Manages animations, keyframes, interpolation, and playback.
 * Follows Spine conventions for bone keyframe tracks.
 */
import { bus } from './EventBus.js';

/**
 * Lerp a single value
 */
function lerp(a, b, t) {
    return a + (b - a) * t;
}

/**
 * Shortest-path angle lerp (degrees)
 */
function lerpAngle(a, b, t) {
    let diff = ((b - a + 180) % 360) - 180;
    if (diff < -180) diff += 360;
    return a + diff * t;
}

/**
 * Represents a single keyframe for a bone property track.
 */
class Keyframe {
    constructor(time, value, curve = 'linear') {
        this.time = time;
        this.value = value;
        this.curve = curve; // 'linear', 'stepped', or [cx1, cy1, cx2, cy2] bezier
    }
}

/**
 * A single animation track for one bone property (e.g., "x", "y", "rotation").
 */
class BoneTrack {
    constructor(boneName, property) {
        this.boneName = boneName;
        this.property = property; // 'x', 'y', 'rotation', 'scaleX', 'scaleY'
        this.keyframes = []; // sorted by time
    }

    addKeyframe(time, value, curve = 'linear') {
        // Remove existing keyframe at same time
        this.keyframes = this.keyframes.filter(kf => Math.abs(kf.time - time) > 0.001);
        this.keyframes.push(new Keyframe(time, value, curve));
        this.keyframes.sort((a, b) => a.time - b.time);
    }

    removeKeyframeAt(time) {
        this.keyframes = this.keyframes.filter(kf => Math.abs(kf.time - time) > 0.001);
    }

    getValueAt(time) {
        if (this.keyframes.length === 0) return null;
        if (this.keyframes.length === 1) return this.keyframes[0].value;

        // Before first keyframe
        if (time <= this.keyframes[0].time) return this.keyframes[0].value;

        // After last keyframe
        if (time >= this.keyframes[this.keyframes.length - 1].time) {
            return this.keyframes[this.keyframes.length - 1].value;
        }

        // Find surrounding keyframes
        for (let i = 0; i < this.keyframes.length - 1; i++) {
            const kf0 = this.keyframes[i];
            const kf1 = this.keyframes[i + 1];

            if (time >= kf0.time && time <= kf1.time) {
                if (kf0.curve === 'stepped') return kf0.value;

                const t = (time - kf0.time) / (kf1.time - kf0.time);
                const interpolatedT = Array.isArray(kf0.curve) ? this._bezierT(t, kf0.curve) : t;

                if (this.property === 'rotation') {
                    return lerpAngle(kf0.value, kf1.value, interpolatedT);
                }
                return lerp(kf0.value, kf1.value, interpolatedT);
            }
        }

        return this.keyframes[this.keyframes.length - 1].value;
    }

    _bezierT(t, curve) {
        const [cx1, cy1, cx2, cy2] = curve;
        // Approximate cubic bezier with iterative method
        let lo = 0, hi = 1;
        for (let i = 0; i < 16; i++) {
            const mid = (lo + hi) / 2;
            const x = 3 * cx1 * mid * (1 - mid) * (1 - mid) + 3 * cx2 * mid * mid * (1 - mid) + mid * mid * mid;
            if (x < t) lo = mid;
            else hi = mid;
        }
        const tt = (lo + hi) / 2;
        return 3 * cy1 * tt * (1 - tt) * (1 - tt) + 3 * cy2 * tt * tt * (1 - tt) + tt * tt * tt;
    }
}

/**
 * A complete animation containing multiple bone tracks.
 */
class Animation {
    constructor(name, duration = 1.0) {
        this.name = name;
        this.duration = duration;
        this.tracks = []; // BoneTrack[]
    }

    getTrack(boneName, property) {
        return this.tracks.find(t => t.boneName === boneName && t.property === property);
    }

    getOrCreateTrack(boneName, property) {
        let track = this.getTrack(boneName, property);
        if (!track) {
            track = new BoneTrack(boneName, property);
            this.tracks.push(track);
        }
        return track;
    }

    getTracksForBone(boneName) {
        return this.tracks.filter(t => t.boneName === boneName);
    }

    getBoneNames() {
        return [...new Set(this.tracks.map(t => t.boneName))];
    }

    /**
     * Set a keyframe for a bone at the given time with transformation properties.
     */
    setKeyframe(boneName, time, props) {
        const properties = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];
        for (const prop of properties) {
            if (props[prop] !== undefined) {
                const track = this.getOrCreateTrack(boneName, prop);
                track.addKeyframe(time, props[prop]);
            }
        }
    }

    /**
     * Remove all keyframes for a bone at a specific time.
     */
    removeKeyframe(boneName, time) {
        for (const track of this.getTracksForBone(boneName)) {
            track.removeKeyframeAt(time);
        }
        // Clean up empty tracks
        this.tracks = this.tracks.filter(t => t.keyframes.length > 0);
    }

    /**
     * Get interpolated bone pose at a given time.
     */
    getPoseAt(boneName, time) {
        const pose = {};
        for (const track of this.getTracksForBone(boneName)) {
            const val = track.getValueAt(time);
            if (val !== null) pose[track.property] = val;
        }
        return pose;
    }

    /**
     * Get all unique keyframe times for a bone.
     */
    getKeyframeTimes(boneName) {
        const times = new Set();
        for (const track of this.getTracksForBone(boneName)) {
            for (const kf of track.keyframes) {
                times.add(kf.time);
            }
        }
        return [...times].sort((a, b) => a - b);
    }

    /**
     * Get all unique keyframe times across all bones.
     */
    getAllKeyframeTimes() {
        const times = new Set();
        for (const track of this.tracks) {
            for (const kf of track.keyframes) {
                times.add(kf.time);
            }
        }
        return [...times].sort((a, b) => a - b);
    }

    /**
     * Auto-update duration to last keyframe time.
     */
    autoFitDuration() {
        let maxTime = 0;
        for (const track of this.tracks) {
            for (const kf of track.keyframes) {
                maxTime = Math.max(maxTime, kf.time);
            }
        }
        this.duration = Math.max(maxTime, 0.1);
    }

    toJSON() {
        const bones = {};
        for (const track of this.tracks) {
            if (!bones[track.boneName]) bones[track.boneName] = {};
            const propName = track.property === 'rotation' ? 'rotate' :
                track.property === 'x' || track.property === 'y' ? 'translate' :
                    'scale';

            if (!bones[track.boneName][propName]) {
                bones[track.boneName][propName] = [];
            }

            // For translate, merge x & y into single entries
            if (propName === 'translate') {
                for (const kf of track.keyframes) {
                    const existing = bones[track.boneName][propName].find(
                        e => Math.abs(e.time - kf.time) < 0.001
                    );
                    if (existing) {
                        existing[track.property] = Math.round(kf.value * 100) / 100;
                    } else {
                        const entry = { time: Math.round(kf.time * 1000) / 1000 };
                        entry[track.property] = Math.round(kf.value * 100) / 100;
                        bones[track.boneName][propName].push(entry);
                    }
                }
            } else if (propName === 'rotate') {
                for (const kf of track.keyframes) {
                    bones[track.boneName][propName].push({
                        time: Math.round(kf.time * 1000) / 1000,
                        angle: Math.round(kf.value * 100) / 100
                    });
                }
            } else if (propName === 'scale') {
                for (const kf of track.keyframes) {
                    const existing = bones[track.boneName][propName].find(
                        e => Math.abs(e.time - kf.time) < 0.001
                    );
                    if (existing) {
                        existing[track.property] = Math.round(kf.value * 100) / 100;
                    } else {
                        const entry = { time: Math.round(kf.time * 1000) / 1000 };
                        entry[track.property] = Math.round(kf.value * 100) / 100;
                        bones[track.boneName][propName].push(entry);
                    }
                }
            }
        }

        // Sort all keyframe arrays by time
        for (const boneName of Object.keys(bones)) {
            for (const propName of Object.keys(bones[boneName])) {
                bones[boneName][propName].sort((a, b) => a.time - b.time);
            }
        }

        return { bones };
    }
}

/**
 * AnimationSystem — Top-level manager for all animations and playback.
 */
export default class AnimationSystem {
    constructor(boneSystem) {
        this.boneSystem = boneSystem;
        this.animations = [];
        this.currentAnimation = null;

        // Playback state
        this.playing = false;
        this.looping = true;
        this.speed = 1.0;
        this.currentTime = 0;

        // Stored "setup pose" (bone transforms before animation)
        this._setupPose = null;
        this._lastFrameTime = 0;
    }

    createAnimation(name = 'animation', duration = 1.0) {
        // Avoid duplicate names
        let finalName = name;
        let counter = 1;
        while (this.animations.find(a => a.name === finalName)) {
            finalName = `${name}_${counter++}`;
        }

        const anim = new Animation(finalName, duration);
        this.animations.push(anim);
        if (!this.currentAnimation) {
            this.currentAnimation = anim;
        }

        // Auto-capture setup pose if not yet captured
        if (!this._setupPose) {
            this.captureSetupPose();
        }

        bus.emit('animation:created', anim);
        bus.emit('animation:changed');
        return anim;
    }

    deleteAnimation(anim) {
        this.animations = this.animations.filter(a => a !== anim);
        if (this.currentAnimation === anim) {
            this.currentAnimation = this.animations[0] || null;
        }
        bus.emit('animation:changed');
    }

    selectAnimation(anim) {
        this.currentAnimation = anim;
        this.currentTime = 0;
        bus.emit('animation:selected', anim);
        bus.emit('animation:changed');
    }

    /**
     * Insert keyframe for the selected bone at current playhead time.
     */
    insertKeyframe(boneName) {
        if (!this.currentAnimation) {
            this.createAnimation();
        }

        const bone = this.boneSystem.getBoneByName(boneName);
        if (!bone) return;

        this.currentAnimation.setKeyframe(boneName, this.currentTime, {
            x: bone.x,
            y: bone.y,
            rotation: bone.rotation,
            scaleX: bone.scaleX,
            scaleY: bone.scaleY
        });

        // Extend duration if needed
        if (this.currentTime > this.currentAnimation.duration) {
            this.currentAnimation.duration = this.currentTime;
        }

        bus.emit('animation:keyframe-added', { boneName, time: this.currentTime });
        bus.emit('animation:changed');
    }

    /**
     * Remove keyframe for a bone at a specific time.
     */
    removeKeyframe(boneName, time) {
        if (!this.currentAnimation) return;
        this.currentAnimation.removeKeyframe(boneName, time);
        bus.emit('animation:keyframe-removed', { boneName, time });
        bus.emit('animation:changed');
    }

    /**
     * Store the current bone transforms as the setup pose.
     */
    captureSetupPose() {
        this._setupPose = {};
        for (const bone of this.boneSystem.bones) {
            this._setupPose[bone.name] = {
                x: bone.x,
                y: bone.y,
                rotation: bone.rotation,
                scaleX: bone.scaleX,
                scaleY: bone.scaleY
            };
        }
    }

    /**
     * Restore the setup pose to bones.
     */
    restoreSetupPose() {
        if (!this._setupPose) return;
        for (const bone of this.boneSystem.bones) {
            const pose = this._setupPose[bone.name];
            if (pose) {
                bone.x = pose.x;
                bone.y = pose.y;
                bone.rotation = pose.rotation;
                bone.scaleX = pose.scaleX;
                bone.scaleY = pose.scaleY;
            }
        }
        this.boneSystem.updateWorldTransforms();
    }

    /**
     * Apply animation pose at the given time to bones.
     */
    applyPose(time) {
        if (!this.currentAnimation) return;

        // Start from setup pose
        this.restoreSetupPose();

        // Apply animation overrides
        for (const boneName of this.currentAnimation.getBoneNames()) {
            const bone = this.boneSystem.getBoneByName(boneName);
            if (!bone) continue;

            const pose = this.currentAnimation.getPoseAt(boneName, time);
            if (pose.x !== undefined) bone.x = pose.x;
            if (pose.y !== undefined) bone.y = pose.y;
            if (pose.rotation !== undefined) bone.rotation = pose.rotation;
            if (pose.scaleX !== undefined) bone.scaleX = pose.scaleX;
            if (pose.scaleY !== undefined) bone.scaleY = pose.scaleY;
        }

        this.boneSystem.updateWorldTransforms();
    }

    // -------- Playback --------

    play() {
        if (!this.currentAnimation) return;
        if (!this._setupPose) this.captureSetupPose();

        this.playing = true;
        this._lastFrameTime = performance.now();
        bus.emit('animation:play');
    }

    pause() {
        this.playing = false;
        bus.emit('animation:pause');
    }

    stop() {
        this.playing = false;
        this.currentTime = 0;
        this.restoreSetupPose();
        bus.emit('animation:stop');
        bus.emit('animation:timechange', 0);
    }

    togglePlay() {
        if (this.playing) this.pause();
        else this.play();
    }

    /**
     * Called each frame from the render loop.
     */
    tick() {
        if (!this.playing || !this.currentAnimation) return;

        const now = performance.now();
        const dt = (now - this._lastFrameTime) / 1000;
        this._lastFrameTime = now;

        this.currentTime += dt * this.speed;

        if (this.currentTime >= this.currentAnimation.duration) {
            if (this.looping) {
                this.currentTime = this.currentTime % this.currentAnimation.duration;
            } else {
                this.currentTime = this.currentAnimation.duration;
                this.playing = false;
                bus.emit('animation:finished');
            }
        }

        this.applyPose(this.currentTime);
        bus.emit('animation:timechange', this.currentTime);
    }

    seek(time) {
        this.currentTime = Math.max(0, time);
        if (this.currentAnimation) {
            this.currentTime = Math.min(this.currentTime, this.currentAnimation.duration);
        }
        if (!this.playing && this._setupPose) {
            this.applyPose(this.currentTime);
        }
        bus.emit('animation:timechange', this.currentTime);
    }

    // -------- Export --------

    toJSON() {
        const result = {};
        for (const anim of this.animations) {
            result[anim.name] = anim.toJSON();
        }
        return result;
    }
}

export { Animation, BoneTrack, Keyframe };
