/**
 * Timeline — Canvas-based timeline UI for animation editing.
 * Renders time ruler, playhead, bone track rows, and keyframe diamonds.
 */
import { bus } from '../core/EventBus.js';

const RULER_HEIGHT = 28;
const TRACK_HEIGHT = 26;
const HEADER_WIDTH = 140;
const PIXELS_PER_SECOND = 120;
const DIAMOND_SIZE = 6;

export default class Timeline {
    constructor(animationSystem, boneSystem) {
        this.animSystem = animationSystem;
        this.boneSystem = boneSystem;

        // DOM
        this.container = document.getElementById('timeline-panel');
        this.canvas = document.getElementById('timeline-canvas');
        this.ctx = this.canvas.getContext('2d');

        // Controls
        this.btnPlay = document.getElementById('tl-play');
        this.btnStop = document.getElementById('tl-stop');
        this.btnLoop = document.getElementById('tl-loop');
        this.btnAddAnim = document.getElementById('tl-add-anim');
        this.btnAddKey = document.getElementById('tl-add-key');
        this.animSelect = document.getElementById('tl-anim-select');
        this.timeDisplay = document.getElementById('tl-time');

        // State
        this.scrollX = 0;
        this.scrollY = 0;
        this.draggingPlayhead = false;
        this.hoveredKeyframe = null;

        this._init();
    }

    _init() {
        this._resize();
        window.addEventListener('resize', () => this._resize());

        // Control buttons
        this.btnPlay?.addEventListener('click', () => {
            this.animSystem.togglePlay();
            this._updatePlayButton();
        });

        this.btnStop?.addEventListener('click', () => {
            this.animSystem.stop();
            this._updatePlayButton();
            this.render();
        });

        this.btnLoop?.addEventListener('click', () => {
            this.animSystem.looping = !this.animSystem.looping;
            this.btnLoop.classList.toggle('active', this.animSystem.looping);
        });

        this.btnAddAnim?.addEventListener('click', () => {
            const name = prompt('Animation name:', `anim_${this.animSystem.animations.length + 1}`);
            if (name) {
                const anim = this.animSystem.createAnimation(name, 2.0);
                this.animSystem.selectAnimation(anim);
                this._updateAnimSelect();
                this.render();
            }
        });

        this.btnAddKey?.addEventListener('click', () => {
            this._insertKeyframeForSelected();
        });

        this.animSelect?.addEventListener('change', () => {
            const anim = this.animSystem.animations.find(a => a.name === this.animSelect.value);
            if (anim) {
                this.animSystem.selectAnimation(anim);
                this.render();
            }
        });

        // Canvas interactions
        this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
        this.canvas.addEventListener('dblclick', (e) => this._onDoubleClick(e));
        this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

        // Listen for animation events
        bus.on('animation:timechange', (time) => {
            this._updateTimeDisplay();
            this.render();
        });

        bus.on('animation:changed', () => {
            this._updateAnimSelect();
            this.render();
        });

        bus.on('animation:play', () => this._updatePlayButton());
        bus.on('animation:pause', () => this._updatePlayButton());
        bus.on('animation:stop', () => this._updatePlayButton());
        bus.on('animation:finished', () => this._updatePlayButton());

        bus.on('bones:changed', () => this.render());

        // Initial state
        this.btnLoop?.classList.add('active');
        this._updateAnimSelect();
        this.render();
    }

    _resize() {
        if (!this.canvas || !this.container) return;
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.canvas.style.width = rect.width + 'px';
        this.canvas.style.height = rect.height + 'px';
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.width = rect.width;
        this.height = rect.height;
        this.render();
    }

    _insertKeyframeForSelected() {
        const bone = this.boneSystem.selectedBone;
        if (!bone) {
            bus.emit('toast', { message: 'Select a bone first', type: 'warning' });
            return;
        }
        if (!this.animSystem.currentAnimation) {
            this.animSystem.createAnimation('animation', 2.0);
            this.animSystem.captureSetupPose();
        }
        this.animSystem.insertKeyframe(bone.name);
        this.render();
    }

    // -------- Coordinate helpers --------

    _timeToX(time) {
        return HEADER_WIDTH + time * PIXELS_PER_SECOND - this.scrollX;
    }

    _xToTime(x) {
        return Math.max(0, (x - HEADER_WIDTH + this.scrollX) / PIXELS_PER_SECOND);
    }

    _trackToY(index) {
        return RULER_HEIGHT + index * TRACK_HEIGHT - this.scrollY;
    }

    _yToTrack(y) {
        return Math.floor((y - RULER_HEIGHT + this.scrollY) / TRACK_HEIGHT);
    }

    // -------- Events --------

    _onMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Ruler area: scrub playhead
        if (y < RULER_HEIGHT && x > HEADER_WIDTH) {
            this.draggingPlayhead = true;
            const time = this._xToTime(x);
            this.animSystem.seek(time);
            if (!this.animSystem.playing && this.animSystem._setupPose) {
                this.animSystem.applyPose(time);
            }
            this.render();
            return;
        }

        // Track area: select keyframe or set playhead
        if (y >= RULER_HEIGHT && x > HEADER_WIDTH) {
            const time = this._xToTime(x);
            const trackIdx = this._yToTrack(y);

            // Check for keyframe hit
            const kf = this._hitTestKeyframe(x, y);
            if (kf) {
                // Select the bone for this keyframe
                const bone = this.boneSystem.getBoneByName(kf.boneName);
                if (bone) this.boneSystem.selectBone(bone);
                this.animSystem.seek(kf.time);
                this.render();
                return;
            }

            // Otherwise scrub playhead
            this.draggingPlayhead = true;
            this.animSystem.seek(time);
            this.render();
        }

        // Track header: select bone
        if (x < HEADER_WIDTH && y >= RULER_HEIGHT) {
            const trackIdx = this._yToTrack(y);
            const bones = this._getTrackBones();
            if (trackIdx >= 0 && trackIdx < bones.length) {
                this.boneSystem.selectBone(bones[trackIdx]);
                bus.emit('bones:changed');
                this.render();
            }
        }
    }

    _onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (this.draggingPlayhead) {
            const time = this._xToTime(x);
            this.animSystem.seek(time);
            if (!this.animSystem.playing && this.animSystem._setupPose) {
                this.animSystem.applyPose(time);
            }
            this.render();
            return;
        }

        // Check hover on keyframes
        const kf = this._hitTestKeyframe(x, y);
        if (kf !== this.hoveredKeyframe) {
            this.hoveredKeyframe = kf;
            this.canvas.style.cursor = kf ? 'pointer' : 'default';
            this.render();
        }
    }

    _onMouseUp(e) {
        this.draggingPlayhead = false;
    }

    _onDoubleClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (y >= RULER_HEIGHT && x > HEADER_WIDTH) {
            const trackIdx = this._yToTrack(y);
            const bones = this._getTrackBones();

            if (trackIdx >= 0 && trackIdx < bones.length) {
                const bone = bones[trackIdx];
                const time = this._xToTime(x);
                // Snap time to nearest 0.05
                const snappedTime = Math.round(time * 20) / 20;

                if (!this.animSystem.currentAnimation) {
                    this.animSystem.createAnimation('animation', 2.0);
                    this.animSystem.captureSetupPose();
                }

                this.animSystem.currentTime = snappedTime;
                this.animSystem.insertKeyframe(bone.name);
                this.render();
            }
        }
    }

    _onWheel(e) {
        e.preventDefault();
        if (e.shiftKey) {
            this.scrollY = Math.max(0, this.scrollY + e.deltaY * 0.5);
        } else {
            this.scrollX = Math.max(0, this.scrollX + e.deltaY * 0.5);
        }
        this.render();
    }

    _hitTestKeyframe(x, y) {
        const anim = this.animSystem.currentAnimation;
        if (!anim) return null;

        const bones = this._getTrackBones();
        for (let i = 0; i < bones.length; i++) {
            const bone = bones[i];
            const times = anim.getKeyframeTimes(bone.name);
            const ty = this._trackToY(i) + TRACK_HEIGHT / 2;

            for (const time of times) {
                const tx = this._timeToX(time);
                if (Math.abs(x - tx) < DIAMOND_SIZE + 2 && Math.abs(y - ty) < DIAMOND_SIZE + 2) {
                    return { boneName: bone.name, time, trackIndex: i };
                }
            }
        }
        return null;
    }

    _getTrackBones() {
        // Show all bones as tracks
        return this.boneSystem.bones;
    }

    // -------- Rendering --------

    render() {
        if (!this.ctx || !this.width) return;
        const ctx = this.ctx;

        ctx.clearRect(0, 0, this.width, this.height);

        this._drawBackground(ctx);
        this._drawRuler(ctx);
        this._drawTracks(ctx);
        this._drawKeyframes(ctx);
        this._drawPlayhead(ctx);
    }

    _drawBackground(ctx) {
        // Track header background
        ctx.fillStyle = '#181c22';
        ctx.fillRect(0, 0, HEADER_WIDTH, this.height);

        // Track area background
        ctx.fillStyle = '#11141a';
        ctx.fillRect(HEADER_WIDTH, RULER_HEIGHT, this.width - HEADER_WIDTH, this.height - RULER_HEIGHT);

        // Draw alternating track rows
        const bones = this._getTrackBones();
        for (let i = 0; i < bones.length; i++) {
            const y = this._trackToY(i);
            if (y + TRACK_HEIGHT < RULER_HEIGHT || y > this.height) continue;

            if (i % 2 === 1) {
                ctx.fillStyle = 'rgba(255,255,255,0.02)';
                ctx.fillRect(0, y, this.width, TRACK_HEIGHT);
            }

            // Selected bone highlight
            if (bones[i] === this.boneSystem.selectedBone) {
                ctx.fillStyle = 'rgba(79, 156, 247, 0.08)';
                ctx.fillRect(0, y, this.width, TRACK_HEIGHT);
            }
        }
    }

    _drawRuler(ctx) {
        // Ruler background
        ctx.fillStyle = '#1a1e25';
        ctx.fillRect(0, 0, this.width, RULER_HEIGHT);

        // Ruler border
        ctx.strokeStyle = '#2a303b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, RULER_HEIGHT);
        ctx.lineTo(this.width, RULER_HEIGHT);
        ctx.stroke();

        // Header/track divider
        ctx.beginPath();
        ctx.moveTo(HEADER_WIDTH, 0);
        ctx.lineTo(HEADER_WIDTH, this.height);
        ctx.stroke();

        // Time markers
        const anim = this.animSystem.currentAnimation;
        const duration = anim ? anim.duration : 2.0;

        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';

        // Calculate tick interval based on zoom
        const tickInterval = 0.1;
        const majorInterval = 0.5;

        for (let t = 0; t <= duration + 1; t += tickInterval) {
            const x = this._timeToX(t);
            if (x < HEADER_WIDTH || x > this.width) continue;

            const isMajor = Math.abs(t % majorInterval) < 0.01 || Math.abs(t % majorInterval - majorInterval) < 0.01;
            const isSecond = Math.abs(t % 1.0) < 0.01 || Math.abs(t % 1.0 - 1.0) < 0.01;

            ctx.beginPath();
            if (isSecond) {
                ctx.strokeStyle = '#4a5060';
                ctx.moveTo(x, RULER_HEIGHT - 14);
                ctx.lineTo(x, RULER_HEIGHT);

                // Label
                ctx.fillStyle = '#9ca3b4';
                ctx.fillText(`${t.toFixed(1)}s`, x, RULER_HEIGHT - 16);

                // Grid line
                ctx.save();
                ctx.strokeStyle = 'rgba(255,255,255,0.05)';
                ctx.beginPath();
                ctx.moveTo(x, RULER_HEIGHT);
                ctx.lineTo(x, this.height);
                ctx.stroke();
                ctx.restore();
            } else if (isMajor) {
                ctx.strokeStyle = '#3a4255';
                ctx.moveTo(x, RULER_HEIGHT - 8);
                ctx.lineTo(x, RULER_HEIGHT);
            } else {
                ctx.strokeStyle = '#2a303b';
                ctx.moveTo(x, RULER_HEIGHT - 4);
                ctx.lineTo(x, RULER_HEIGHT);
            }
            ctx.stroke();
        }

        // Duration end marker
        if (anim) {
            const endX = this._timeToX(anim.duration);
            ctx.strokeStyle = '#f87171';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 2]);
            ctx.beginPath();
            ctx.moveTo(endX, RULER_HEIGHT);
            ctx.lineTo(endX, this.height);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    _drawTracks(ctx) {
        const bones = this._getTrackBones();
        ctx.font = '11px "Inter", sans-serif';
        ctx.textAlign = 'left';

        for (let i = 0; i < bones.length; i++) {
            const bone = bones[i];
            const y = this._trackToY(i);
            if (y + TRACK_HEIGHT < RULER_HEIGHT || y > this.height) continue;

            const boneColor = bone.color || '#c8d850';
            const isSelected = bone === this.boneSystem.selectedBone;

            // Track label — use bone's group color
            ctx.fillStyle = isSelected ? boneColor : '#9ca3b4';
            ctx.fillText(bone.name, 12, y + TRACK_HEIGHT / 2 + 4, HEADER_WIDTH - 16);

            // Bone dot — use bone's group color
            const dotX = HEADER_WIDTH - 14;
            const dotY = y + TRACK_HEIGHT / 2;
            ctx.beginPath();
            ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
            ctx.fillStyle = boneColor;
            ctx.fill();

            // Subtle color bar on left edge
            ctx.fillStyle = isSelected ? boneColor : boneColor + '30';
            ctx.fillRect(0, y, 3, TRACK_HEIGHT);

            // Track separator
            ctx.strokeStyle = '#1e222a';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, y + TRACK_HEIGHT);
            ctx.lineTo(this.width, y + TRACK_HEIGHT);
            ctx.stroke();
        }
    }

    _drawKeyframes(ctx) {
        const anim = this.animSystem.currentAnimation;
        if (!anim) return;

        const bones = this._getTrackBones();

        for (let i = 0; i < bones.length; i++) {
            const bone = bones[i];
            const boneColor = bone.color || '#c8d850';
            const times = anim.getKeyframeTimes(bone.name);
            const y = this._trackToY(i) + TRACK_HEIGHT / 2;

            // Parse bone color for darker stroke variant
            const cr = parseInt(boneColor.slice(1, 3), 16);
            const cg = parseInt(boneColor.slice(3, 5), 16);
            const cb = parseInt(boneColor.slice(5, 7), 16);
            const darkStroke = `rgb(${Math.round(cr * 0.6)}, ${Math.round(cg * 0.6)}, ${Math.round(cb * 0.6)})`;

            for (const time of times) {
                const x = this._timeToX(time);
                if (x < HEADER_WIDTH - DIAMOND_SIZE || x > this.width + DIAMOND_SIZE) continue;

                const isHovered = this.hoveredKeyframe &&
                    this.hoveredKeyframe.boneName === bone.name &&
                    Math.abs(this.hoveredKeyframe.time - time) < 0.001;
                const isAtPlayhead = Math.abs(time - this.animSystem.currentTime) < 0.01;

                // Diamond shape
                ctx.beginPath();
                ctx.moveTo(x, y - DIAMOND_SIZE);
                ctx.lineTo(x + DIAMOND_SIZE, y);
                ctx.lineTo(x, y + DIAMOND_SIZE);
                ctx.lineTo(x - DIAMOND_SIZE, y);
                ctx.closePath();

                if (isAtPlayhead) {
                    ctx.fillStyle = '#fbbf24';
                    ctx.strokeStyle = '#f59e0b';
                } else if (isHovered) {
                    ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, 0.9)`;
                    ctx.strokeStyle = boneColor;
                } else {
                    ctx.fillStyle = boneColor;
                    ctx.strokeStyle = darkStroke;
                }

                ctx.fill();
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }
    }

    _drawPlayhead(ctx) {
        const x = this._timeToX(this.animSystem.currentTime);
        if (x < HEADER_WIDTH) return;

        // Playhead triangle in ruler
        ctx.fillStyle = '#4ade80';
        ctx.beginPath();
        ctx.moveTo(x - 5, 2);
        ctx.lineTo(x + 5, 2);
        ctx.lineTo(x + 5, RULER_HEIGHT - 8);
        ctx.lineTo(x, RULER_HEIGHT - 2);
        ctx.lineTo(x - 5, RULER_HEIGHT - 8);
        ctx.closePath();
        ctx.fill();

        // Playhead line
        ctx.strokeStyle = '#4ade80';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, RULER_HEIGHT);
        ctx.lineTo(x, this.height);
        ctx.stroke();
    }

    _updatePlayButton() {
        if (!this.btnPlay) return;
        this.btnPlay.textContent = this.animSystem.playing ? '⏸' : '▶';
        this.btnPlay.title = this.animSystem.playing ? 'Pause' : 'Play';
    }

    _updateTimeDisplay() {
        if (!this.timeDisplay) return;
        this.timeDisplay.textContent = `${this.animSystem.currentTime.toFixed(2)}s`;
    }

    _updateAnimSelect() {
        if (!this.animSelect) return;
        const current = this.animSystem.currentAnimation;
        this.animSelect.innerHTML = '';

        if (this.animSystem.animations.length === 0) {
            const opt = document.createElement('option');
            opt.textContent = '(no animation)';
            opt.disabled = true;
            opt.selected = true;
            this.animSelect.appendChild(opt);
            return;
        }

        for (const anim of this.animSystem.animations) {
            const opt = document.createElement('option');
            opt.value = anim.name;
            opt.textContent = anim.name;
            opt.selected = anim === current;
            this.animSelect.appendChild(opt);
        }
    }
}
