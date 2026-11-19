// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

export {
    createVoiceOrb,
    fibonacciSphere,
    generateParticles,
    initialQuality,
    MAX_PARTICLES,
    MIN_QUALITY,
    orbEnergy,
    type OrbParticle,
    type OrbPreset,
    type OrbState,
    particleCount,
    type Point3,
    presetFor,
    projectPoint,
    type Projection,
    type QualityState,
    stepQuality,
    type VoiceOrb,
    type VoiceOrbOptions,
    waveHeights,
} from './voice-orb.js';
export * from './category-browser/index.js';
export * from './knowledge-sphere/index.js';
export * from './map-viz/index.js';
export {
    ICON_NAMES,
    ICON_STROKE,
    ICON_VIEWBOX,
    SMALL_ICON_MAX_PX,
    iconMarkup,
    iconSvg,
    resolveIconName,
} from './icons.js';
export type { IconName } from './icons.js';
