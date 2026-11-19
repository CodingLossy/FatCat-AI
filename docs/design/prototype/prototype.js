// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 尹绪柏 (Theodore Yin)

/* global document, location, matchMedia, devicePixelRatio, requestAnimationFrame, addEventListener, window, URLSearchParams */

// Static prototype for the M12 core orb and view switching. Not production code (see docs/design/ui-redesign.md §4).
(function () {
    'use strict';

    var params = new URLSearchParams(location.search);
    var STATE = params.get('state') || 'speaking'; // listening | thinking | speaking
    var STATIC = params.get('static') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches;

    document.querySelectorAll('[data-version]').forEach(function (el) {
        el.textContent = window.__PKG_VERSION__ || '';
    });

    // ---------- views ----------
    function show() {
        var id = (location.hash || '#files').slice(1);
        var view = id.split('-')[0];
        var sub = id.split('-')[1] || '';
        document.querySelectorAll('.view').forEach(function (v) {
            v.classList.toggle('on', v.dataset.view === view);
        });
        if (view === 'wb' || view === 'phone') {
            var key = sub || 'files';
            document.querySelectorAll('.view.on .pv').forEach(function (p) {
                p.classList.toggle('on', p.dataset.pv === key);
            });
            document.querySelectorAll('.view.on .rail a, .view.on .tabbar a').forEach(function (a) {
                a.classList.toggle('on', a.getAttribute('href') === '#' + view + '-' + key);
            });
        }
        startOrbs();
    }
    // map the short hashes used by the screenshot script
    function normalize() {
        var h = location.hash.slice(1);
        var map = { files: 'wb-files', diff: 'wb-diff', mail: 'wb-mail', memory: 'wb-memory', browser: 'wb-browser' };
        if (map[h]) location.hash = map[h];
        else if (!h) location.hash = 'wb-files';
        else show();
    }
    addEventListener('hashchange', normalize);

    // ---------- wave bars ----------
    function buildWave(el) {
        for (var i = 0; i < 56; i++) el.appendChild(document.createElement('i'));
    }
    var waves = [];
    function setWave(t) {
        waves.forEach(function (w) {
            var bars = w.children;
            for (var i = 0; i < bars.length; i++) {
                var amp = STATE === 'speaking' ? 1 : STATE === 'thinking' ? 0.18 : 0.1;
                var env = Math.sin((Math.PI * i) / (bars.length - 1));
                var v = Math.abs(Math.sin(i * 0.9 + t * 7) * 0.6 + Math.sin(i * 0.37 - t * 4) * 0.4);
                bars[i].style.setProperty('--h', Math.max(3, 4 + amp * env * v * 44) + 'px');
            }
        });
    }

    // ---------- orb ----------
    function mulberry32(a) {
        return function () {
            a |= 0;
            a = (a + 0x6d2b79f5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    var MAX = 2600;
    var pts = [];
    (function () {
        var rnd = mulberry32(7);
        var golden = Math.PI * (3 - Math.sqrt(5));
        for (var i = 0; i < MAX; i++) {
            var y = 1 - (2 * (i + 0.5)) / MAX;
            var r = Math.sqrt(1 - y * y);
            var th = golden * i;
            pts.push({
                x: Math.cos(th) * r,
                y: y,
                z: Math.sin(th) * r,
                s: rnd(),
                b: rnd(),
                ice: rnd() < 0.16,
                ph: rnd() * 6.28,
            });
        }
    })();

    // density / motion per state (ADR 0046 §4): only these numbers change between states
    var PRESET = {
        listening: { density: 0.5, spin: 0.12, jitter: 0.004, pulse: 0.012, bandIce: false },
        thinking: { density: 1.0, spin: 0.5, jitter: 0.014, pulse: 0.004, bandIce: true },
        speaking: { density: 0.78, spin: 0.2, jitter: 0.006, pulse: 0.05, bandIce: false },
    };

    var quality = 1; // lowered automatically on slow frames
    var orbs = [];

    function drawOrb(o, t) {
        var c = o.canvas;
        var dpr = Math.min(devicePixelRatio || 1, 2);
        var w = c.clientWidth;
        var h = c.clientHeight;
        if (!w) return;
        if (c.width !== Math.round(w * dpr)) {
            c.width = Math.round(w * dpr);
            c.height = Math.round(h * dpr);
        }
        var g = c.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        var p = PRESET[STATE];
        var R = w * 0.47;
        var cx = w / 2;
        var cy = h / 2;
        var rot = t * p.spin + 0.6;
        var cosR = Math.cos(rot);
        var sinR = Math.sin(rot);
        var tilt = 0.3;
        var cosT = Math.cos(tilt);
        var sinT = Math.sin(tilt);
        var amp = STATE === 'speaking' ? 0.5 + 0.5 * Math.sin(t * 6.1) * Math.sin(t * 2.3 + 1) : 0;
        var breathe = 1 + p.pulse * (STATE === 'speaking' ? amp : Math.sin(t * 2.2));

        function project(x, y, z, k) {
            var x1 = x * cosR + z * sinR;
            var z1 = -x * sinR + z * cosR;
            var y1 = y * cosT - z1 * sinT;
            var z2 = y * sinT + z1 * cosT;
            var persp = 1 + 0.16 * z2; // nearer points are larger: simple depth of field
            var s = R * breathe * k * persp;
            return [cx + x1 * s, cy + y1 * s, z2];
        }

        // wireframe: latitude rings and meridians, 1px, low alpha
        // soft volume: a very faint radial tint plus a hairline limb
        var vol = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.02);
        vol.addColorStop(0, 'rgba(120,150,210,0.07)');
        vol.addColorStop(1, 'rgba(120,150,210,0.0)');
        g.fillStyle = vol;
        g.beginPath();
        g.arc(cx, cy, R * 1.02, 0, 6.2832);
        g.fill();
        g.lineWidth = 0.5;
        g.strokeStyle = 'rgba(226,232,255,0.16)';
        g.beginPath();
        g.arc(cx, cy, R * 1.02, 0, 6.2832);
        g.stroke();
        g.strokeStyle = 'rgba(226,232,255,0.10)'; // wireframe: ~10% opacity, 0.5px
        var lat;
        var lon;
        var i;
        for (lat = -60; lat <= 60; lat += 30) {
            g.beginPath();
            var ly = Math.sin((lat * Math.PI) / 180);
            var lr = Math.cos((lat * Math.PI) / 180);
            for (i = 0; i <= 64; i++) {
                var a = (i / 64) * Math.PI * 2;
                var q = project(Math.cos(a) * lr, ly, Math.sin(a) * lr, 1);
                if (i) g.lineTo(q[0], q[1]);
                else g.moveTo(q[0], q[1]);
            }
            g.stroke();
        }
        for (lon = 0; lon < 180; lon += 30) {
            g.beginPath();
            var b = (lon * Math.PI) / 180;
            for (i = 0; i <= 64; i++) {
                var a2 = (i / 64) * Math.PI * 2;
                var q2 = project(Math.cos(a2) * Math.cos(b), Math.sin(a2), Math.cos(a2) * Math.sin(b), 1);
                if (i) g.lineTo(q2[0], q2[1]);
                else g.moveTo(q2[0], q2[1]);
            }
            g.stroke();
        }

        // particles
        var n = Math.floor(MAX * p.density * quality);
        for (i = 0; i < n; i++) {
            var pt = pts[i];
            var jx = Math.sin(t * 1.7 + pt.ph) * p.jitter;
            var jy = Math.cos(t * 1.3 + pt.ph * 2) * p.jitter;
            var lift = STATE === 'speaking' ? 1 + 0.035 * amp * Math.sin(pt.ph * 3 + t * 5) : 1;
            var q3 = project((pt.x + jx) * lift, (pt.y + jy) * lift, pt.z * lift, 1);
            var depth = (q3[2] + 1) / 2; // 0 back .. 1 front
            var inBand = p.bandIce && Math.abs(pt.y - Math.sin(t * 0.9) * 0.8) < 0.06;
            var ice = pt.ice || inBand;
            var alpha = Math.min(1, (0.2 + 0.8 * depth) * (0.6 + 0.6 * pt.b));
            g.fillStyle = ice
                ? 'rgba(56,189,248,' + alpha.toFixed(2) + ')'
                : 'rgba(226,232,255,' + alpha.toFixed(2) + ')';
            var sz = (0.4 + pt.s * pt.s * 1.6) * (0.5 + 0.9 * depth);
            g.beginPath();
            g.arc(q3[0], q3[1], sz, 0, 6.2832);
            g.fill();
        }
    }

    function startOrbs() {
        orbs = [];
        document.querySelectorAll('.view.on canvas[data-orb]').forEach(function (canvas) {
            orbs.push({ canvas: canvas });
        });
        waves = [];
        document.querySelectorAll('.view.on .wave').forEach(function (w) {
            if (!w.children.length) buildWave(w);
            waves.push(w);
        });
        var t0 = 4.2; // fixed phase for the static render so screenshots are reproducible
        orbs.forEach(function (o) {
            drawOrb(o, t0);
        });
        setWave(t0);
        document.documentElement.dataset.orbReady = '1';
    }

    var last = 0;
    var slow = 0;
    function frame(ts) {
        requestAnimationFrame(frame);
        if (STATIC || document.hidden) return;
        var dt = ts - last;
        last = ts;
        // adaptive quality: ~60 fps target; sustained slow frames reduce the particle count (floor 35%)
        if (dt > 24) slow++;
        else slow = Math.max(0, slow - 1);
        if (slow > 45 && quality > 0.35) {
            quality = Math.max(0.35, quality * 0.8);
            slow = 0;
        }
        orbs.forEach(function (o) {
            drawOrb(o, ts / 1000);
        });
        setWave(ts / 1000);
    }
    requestAnimationFrame(frame);

    // dev helper for the screenshot script: set the state without reloading
    window.__setState = function (s) {
        STATE = s;
        startOrbs();
        document.querySelectorAll('[data-state-label]').forEach(function (el) {
            el.hidden = el.dataset.stateLabel !== s;
        });
    };

    document.querySelectorAll('[data-state-label]').forEach(function (el) {
        el.hidden = el.dataset.stateLabel !== STATE;
    });
    normalize();
})();
