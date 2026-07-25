// ==UserScript==
// @name         [TikTok] Downloader
// @namespace    https://github.com/myouisaur/TikTok
// @icon         https://www.tiktok.com/favicon.ico
// @version      10.0
// @description  Adds a button to easily download TikTok videos and photo galleries.
// @author       Xiv
// @match        *://*.tiktok.com/*
// @match        *://ssstik.io/*
// @match        *://savetiktok.to/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
// @noframes
// @updateURL    https://myouisaur.github.io/TikTok/downloader.user.js
// @downloadURL  https://myouisaur.github.io/TikTok/downloader.user.js
// ==/UserScript==

(function() {
    'use strict';

    if (window.xivInitialized) return;
    window.xivInitialized = true;

    // ==========================================
    // CENTRALIZED CONFIGURATION
    // ==========================================
    const CONFIG = {
        debug: false,
        urls: {
            ssstik: 'https://ssstik.io/en',
            savetiktok: 'https://savetiktok.to/en/tiktok-photo-downloader'
        },
        storage: {
            urlKey: 'xiv_tiktok_stored_link',
            stateKey: 'xiv_ssstik_state'
        },
        classes: {
            btn: 'xiv-downloader-btn',
            wrapper: 'xiv-icon-wrapper'
        },
        ids: {
            style: 'xiv-styles',
            saveTikTokStyle: 'xiv-savetiktok-styles'
        },
        colors: {
            bgNormal: '#1F1F1F',
            bgHover:  '#141414',
            bgActive: '#E8E8E8',
            bgError:  '#ff4444',
            fgNormal: '#E8E8E8',
            fgActive: '#1F1F1F',
            fgError:  '#FFFFFF',

            // Context-aware modal colors (matching native TikTok semi-transparent overlay)
            modalBgNormal: 'rgba(255, 255, 255, 0.12)',
            modalBgHover:  'rgba(255, 255, 255, 0.20)',
            modalFgNormal: 'rgba(255, 255, 255, 0.9)'
        },
        selectors: {
            tiktok: {
                actionAnchors: [
                    '[data-e2e="video-author-avatar"]',
                    '[data-e2e="browse-like-icon"]',
                    '[data-e2e="like-icon"]'
                ],
                commentsContainer: '[data-e2e="video-comment-list"], [data-e2e="search-comment-container"], [data-e2e="comment-input"]',
                commentBtn: [
                    '[data-e2e="comment-icon"]',
                    'button[aria-label*="Read or add comments" i]',
                    'button strong[data-e2e="comment-count"]'
                ],
                postContainer: '[data-e2e="recommend-list-item-container"], [data-e2e="search-card"], [data-e2e="user-post-item"], .feed-item, [data-e2e="video-item"]',
                videoLink: 'a[href*="/video/"], a[href*="/photo/"], a[href*="/t/"]'
            },
            ssstik: {
                input: ['#main_page_text'],
                submit: ['#submit'],
                download: ['a.without_watermark']
            },
            savetiktok: {
                input: ['#s_input'],
                submit: ['button.btn-red', 'button[onclick*="ksearchvideo"]']
            }
        },
        timeouts: {
            uiWait:        10000,
            dlMaxWait:     60000,
            tabCloseDelay: 2500,
            actionWait:    300
        }
    };

    // ==========================================
    // CORE UTILITIES
    // ==========================================
    const logger = {
        info:  (...args) => CONFIG.debug && console.log('[TikTok Downloader]', ...args),
        warn:  (...args) => console.warn('[TikTok Downloader]', ...args),
        error: (...args) => console.error('[TikTok Downloader]', ...args)
    };

    const storage = {
        get: (key, def = null) => {
            try { return GM_getValue(key) || def; }
            catch (e) { logger.error(`Failed to read ${key}`, e); return def; }
        },
        set: (key, val) => {
            try { GM_setValue(key, val); }
            catch (e) { logger.error(`Failed to write ${key}`, e); }
        },
        listen: (key, callback) => {
            try {
                if (typeof GM_addValueChangeListener !== 'undefined') {
                    GM_addValueChangeListener(key, callback);
                }
            } catch (e) { logger.error(`Failed to listen to ${key}`, e); }
        }
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    const domUtils = {
        simulateClick: (element) => {
            if (!element) return;
            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            element.click();
        },

        setInputValue: (inputEl, value) => {
            try {
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (nativeSetter) nativeSetter.call(inputEl, value);
                else inputEl.value = value;

                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) {
                logger.error('Failed to inject value into input', e);
            }
        },

        waitForElement: (selectors, timeoutMs = CONFIG.timeouts.uiWait) => {
            const selectorArray = Array.isArray(selectors) ? selectors : [selectors];

            return new Promise((resolve, reject) => {
                const checkElements = () => {
                    for (const sel of selectorArray) {
                        const el = document.querySelector(sel);
                        if (el) return el;
                    }
                    return null;
                };

                const initial = checkElements();
                if (initial) return resolve(initial);

                const observer = new MutationObserver((_, obs) => {
                    const found = checkElements();
                    if (found) {
                        obs.disconnect();
                        clearTimeout(timer);
                        resolve(found);
                    }
                });

                observer.observe(document.documentElement, { childList: true, subtree: true });

                const timer = setTimeout(() => {
                    observer.disconnect();
                    reject(new Error(`Element(s) '${selectorArray.join(', ')}' not found`));
                }, timeoutMs);
            });
        }
    };

    const findElementSync = (selectorArray, parent = document) => {
        for (const selector of selectorArray) {
            const el = parent.querySelector(selector);
            if (el) return el;
        }
        return null;
    };

    // ==========================================
    // TIKTOK MODULE
    // ==========================================
    if (window.location.hostname.includes('tiktok.com')) {

        let domObserver = null;
        let debounceTimer = null;
        let autoOpenObserver = null;
        let hasAttemptedAutoOpen = false;

        function injectStyles() {
            if (document.getElementById(CONFIG.ids.style)) return;
            const style = document.createElement('style');
            style.id = CONFIG.ids.style;
            style.textContent = `
                /* Base Styles (Feed Default) */
                .${CONFIG.classes.btn} {
                    background: none; border: none; padding: 0; margin: 0 0 12px 0;
                    display: flex; flex-direction: column; align-items: center; justify-content: center;
                    cursor: pointer; z-index: 999; opacity: 1;
                    transition: opacity 0.2s ease;
                }
                .${CONFIG.classes.btn}[data-state="processing"] {
                    opacity: 0.5; cursor: wait;
                }
                .${CONFIG.classes.wrapper} {
                    width: 48px; height: 48px;
                    background-color: ${CONFIG.colors.bgNormal};
                    border-radius: 50%; display: flex; align-items: center; justify-content: center;
                    color: ${CONFIG.colors.fgNormal};
                    transition: background-color 0.2s ease, color 0.2s ease;
                }
                .${CONFIG.classes.btn}:not([data-state="processing"]):hover .${CONFIG.classes.wrapper} {
                    background-color: ${CONFIG.colors.bgHover};
                }
                .${CONFIG.classes.btn} svg {
                    width: 24px; height: 24px; fill: currentColor;
                }

                /* Context-Aware Overrides (Modal/Theater View) */
                .${CONFIG.classes.btn}[data-view-mode="modal"] {
                    margin: 0;
                    flex-direction: row;
                }
                .${CONFIG.classes.btn}[data-view-mode="modal"] .${CONFIG.classes.wrapper} {
                    width: 32px; height: 32px;
                    background-color: ${CONFIG.colors.modalBgNormal};
                    color: ${CONFIG.colors.modalFgNormal};
                }
                .${CONFIG.classes.btn}[data-view-mode="modal"]:not([data-state="processing"]):hover .${CONFIG.classes.wrapper} {
                    background-color: ${CONFIG.colors.modalBgHover};
                }
                .${CONFIG.classes.btn}[data-view-mode="modal"] svg {
                    width: 20px; height: 20px;
                }
            `;
            (document.head || document.documentElement).appendChild(style);
        }

        function createDownloadIcon() {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z');
            svg.appendChild(path);
            return svg;
        }

        function getExactVideoLink(buttonElement) {
            try {
                const container = buttonElement.closest(CONFIG.selectors.tiktok.postContainer);
                if (container) {
                    const linkEl = container.querySelector(CONFIG.selectors.tiktok.videoLink);
                    if (linkEl && linkEl.href) return linkEl.href.split('?')[0];
                }
            } catch (e) {
                logger.warn('DOM link extraction failed.');
            }
            return window.location.href.split('?')[0];
        }

        function setupZeroOverheadUrlTracker() {
            let lastPath = window.location.pathname;

            const notifyRouteChange = () => {
                const currentPath = window.location.pathname;
                if (currentPath !== lastPath) {
                    lastPath = currentPath;
                    window.dispatchEvent(new Event('xiv:locationchange'));
                }
            };

            const originalPushState = history.pushState;
            const originalReplaceState = history.replaceState;

            history.pushState = function() {
                originalPushState.apply(this, arguments);
                notifyRouteChange();
            };
            history.replaceState = function() {
                originalReplaceState.apply(this, arguments);
                notifyRouteChange();
            };
            window.addEventListener('popstate', () => setTimeout(notifyRouteChange, 50));
            window.addEventListener('xiv:locationchange', handleRouteUpdate);
        }

        function handleRouteUpdate() {
            const path = window.location.pathname;
            const isMainFeed = path === '/' || path.startsWith('/foryou') || path.startsWith('/following') || path.startsWith('/explore');

            if (isMainFeed) {
                hasAttemptedAutoOpen = false;
                if (autoOpenObserver) {
                    autoOpenObserver.disconnect();
                    autoOpenObserver = null;
                }
                autoOpenCommentsOnce();
            }
        }

        function autoOpenCommentsOnce() {
            if (hasAttemptedAutoOpen) return;

            autoOpenObserver = new MutationObserver((mutations, obs) => {
                if (document.hidden) return;

                const commentBtn = findElementSync(CONFIG.selectors.tiktok.commentBtn);
                if (commentBtn) {
                    const commentsAreOpen = findElementSync([CONFIG.selectors.tiktok.commentsContainer]) !== null;
                    if (!commentsAreOpen) {
                        const clickableTarget = commentBtn.closest('button') || commentBtn;
                        domUtils.simulateClick(clickableTarget);
                    }

                    hasAttemptedAutoOpen = true;
                    obs.disconnect();
                    autoOpenObserver = null;
                }
            });

            autoOpenObserver.observe(document.documentElement, { childList: true, subtree: true });

            setTimeout(() => {
                if (!hasAttemptedAutoOpen && autoOpenObserver) {
                    hasAttemptedAutoOpen = true;
                    autoOpenObserver.disconnect();
                    autoOpenObserver = null;
                }
            }, 10000);
        }

        function setupCrossTabSync() {
            storage.listen(CONFIG.storage.stateKey, (key, oldVal, newVal, remote) => {
                if (!newVal || !remote) return;

                const btn = document.querySelector(`.${CONFIG.classes.btn}[data-url="${newVal.url}"]`);
                if (!btn) return;

                const wrapper = btn.querySelector(`.${CONFIG.classes.wrapper}`);

                if (newVal.status === 'success') {
                    btn.dataset.state = 'idle';
                    if (wrapper) {
                        wrapper.style.backgroundColor = '';
                        wrapper.style.color = '';
                    }
                } else if (newVal.status === 'error') {
                    btn.dataset.state = 'idle';
                    if (wrapper) {
                        wrapper.style.backgroundColor = CONFIG.colors.bgError;
                        wrapper.style.color = CONFIG.colors.fgError;
                        setTimeout(() => {
                            wrapper.style.backgroundColor = '';
                            wrapper.style.color = '';
                        }, 3000);
                    }
                }
            });
        }

        function setupDebouncedObserver() {
            if (domObserver) domObserver.disconnect();

            domObserver = new MutationObserver((mutations) => {
                let hasElementAdditions = false;
                for (let i = 0; i < mutations.length; i++) {
                    for (let j = 0; j < mutations[i].addedNodes.length; j++) {
                        if (mutations[i].addedNodes[j].nodeType === Node.ELEMENT_NODE) {
                            hasElementAdditions = true;
                            break;
                        }
                    }
                    if (hasElementAdditions) break;
                }

                if (hasElementAdditions) {
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(maintainUI, 250);
                }
            });

            domObserver.observe(document.documentElement, { childList: true, subtree: true });
            maintainUI();
        }

        function maintainUI() {
            const anchors = document.querySelectorAll(CONFIG.selectors.tiktok.actionAnchors.join(', '));

            anchors.forEach(anchor => {
                let actionBar = null;
                let insertReference = null;
                let detectedViewMode = 'feed';

                if (anchor.matches('[data-e2e="video-author-avatar"]')) {
                    // Standard Vertical Feed View
                    actionBar = anchor.closest('section');
                    if (actionBar) insertReference = actionBar.firstChild;
                } else {
                    // Theater/Modal Horizontal View
                    // Skip if this like button is actually nested inside a standard feed section
                    if (anchor.closest('section')) return;

                    const btnWrapper = anchor.closest('button');
                    if (btnWrapper) {
                        actionBar = btnWrapper.parentElement;
                        insertReference = btnWrapper;
                        detectedViewMode = 'modal';
                    }
                }

                if (actionBar && !actionBar.querySelector(`.${CONFIG.classes.btn}`)) {
                    const btn = document.createElement('button');
                    btn.className = CONFIG.classes.btn;
                    btn.type = 'button';
                    btn.title = 'Download Post';
                    btn.dataset.state = "idle";
                    btn.dataset.viewMode = detectedViewMode;

                    const wrapper = document.createElement('span');
                    wrapper.className = CONFIG.classes.wrapper;
                    wrapper.appendChild(createDownloadIcon());
                    btn.appendChild(wrapper);

                    btn.onclick = (e) => {
                        e.preventDefault(); e.stopPropagation();
                        if (btn.dataset.state === 'processing') return;

                        const exactUrl = getExactVideoLink(btn);
                        const isPhoto = exactUrl.includes('/photo/');
                        const targetServiceUrl = isPhoto ? CONFIG.urls.savetiktok : CONFIG.urls.ssstik;

                        btn.dataset.url = exactUrl;

                        storage.set(CONFIG.storage.urlKey, {
                            url: exactUrl,
                            type: isPhoto ? 'photo' : 'video'
                        });

                        btn.dataset.state = 'processing';

                        wrapper.style.backgroundColor = CONFIG.colors.bgActive;
                        wrapper.style.color = CONFIG.colors.fgActive;

                        setTimeout(() => {
                            GM_openInTab(targetServiceUrl, { active: isPhoto, insert: true });
                        }, 500);
                    };

                    actionBar.insertBefore(btn, insertReference);
                }
            });
        }

        injectStyles();
        setupZeroOverheadUrlTracker();
        setupCrossTabSync();
        handleRouteUpdate();
        setupDebouncedObserver();

        window.addEventListener('beforeunload', () => {
            if (domObserver) domObserver.disconnect();
            if (autoOpenObserver) autoOpenObserver.disconnect();
            clearTimeout(debounceTimer);
        });

    // ==========================================
    // SSSTIK MODULE (Video - Background Tab)
    // ==========================================
    } else if (window.location.hostname.includes('ssstik.io')) {

        const executeVideoDownload = async () => {
            const data = storage.get(CONFIG.storage.urlKey);
            if (!data || data.type !== 'video') return;

            const url = data.url;
            logger.info('Starting automated conversion for video:', url);
            storage.set(CONFIG.storage.urlKey, null);

            const broadcastState = (status) => {
                storage.set(CONFIG.storage.stateKey, { status, url, ts: Date.now() });
            };

            broadcastState('processing');

            try {
                // 1. Wait for form elements
                const input = await domUtils.waitForElement(CONFIG.selectors.ssstik.input);
                const submitBtn = await domUtils.waitForElement(CONFIG.selectors.ssstik.submit);

                // 2. Inject URL & Submit
                domUtils.setInputValue(input, url);
                await sleep(CONFIG.timeouts.actionWait);
                domUtils.simulateClick(submitBtn);

                // 3. Wait for the HTMX swap to reveal the "Without watermark" button
                document.title = "Processing...";
                const finalBtn = await domUtils.waitForElement(CONFIG.selectors.ssstik.download, CONFIG.timeouts.dlMaxWait);

                // 4. Click Download & Cleanup
                document.title = "Downloading...";
                domUtils.simulateClick(finalBtn);

                broadcastState('success');
                setTimeout(() => window.close(), CONFIG.timeouts.tabCloseDelay);

            } catch (error) {
                logger.error('Automation aborted:', error.message);
                document.title = "❌ Conversion Timeout";
                broadcastState('error');
            }
        };

        executeVideoDownload();

    // ==========================================
    // SAVETIKTOK MODULE (Photos - Background Tab)
    // ==========================================
    } else if (window.location.hostname.includes('savetiktok.to')) {

        const ST_ICONS = {
            DOWNLOAD: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>',
            LINK:     '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>',
            CHECK:    '<polyline points="20 6 9 17 4 12" stroke="#4ade80" stroke-width="3"></polyline>',
            SPINNER:  '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="40 20" stroke-linecap="round" class="xiv-spinner"></circle>'
        };

        function injectSaveTikTokEnhancements() {
            if (document.getElementById(CONFIG.ids.saveTikTokStyle)) return;
            const style = document.createElement('style');
            style.id = CONFIG.ids.saveTikTokStyle;
            style.textContent = `
                /* Stop the grid from stretching all cards to the height of the tallest image */
                .download-box {
                    align-items: start !important;
                }

                /* Revert flex hacks from v9.5 so the card just hugs its content natively */
                .download-items {
                    display: block !important;
                    height: auto !important;
                }

                /* Override SaveTikTok's aggressive square cropping and ALL padding hacks */
                .download-items__thumb {
                    position: relative !important; /* Ensure absolute custom UI overlays properly */
                    height: auto !important;
                    aspect-ratio: auto !important;
                    padding: 0 !important; /* Removes ALL padding-based aspect ratio hacks (especially padding-top) */
                    display: block !important;
                    background: rgba(0, 0, 0, 0.03);
                    border-radius: 8px;
                    overflow: hidden;
                    text-align: center !important;
                    user-select: none !important;
                    -webkit-user-select: none !important;
                    -moz-user-select: none !important;
                    -ms-user-select: none !important;
                }

                /* Nuke pseudo-elements often used to enforce aspect ratios */
                .download-items__thumb::before,
                .download-items__thumb::after {
                    display: none !important;
                }

                .download-items__thumb img {
                    position: static !important; /* Overrides absolute positioning from cropping */
                    display: block !important;   /* Ensures margin trick works */
                    width: auto !important;
                    height: auto !important;
                    max-width: 100% !important;
                    max-height: 80vh !important; /* Keeps it strictly inside the viewport height */
                    object-fit: contain !important;
                    margin: 0 auto !important;   /* Horizontally centered, top-aligned */
                    user-drag: none !important;
                    -webkit-user-drag: none !important;
                }

                /* HIDE the native ad-triggering download buttons completely */
                .download-items__btn {
                    display: none !important;
                }

                /* =======================================
                   MODERN UI EXTRACTION OVERLAY
                   ======================================= */
                .xiv-st-container {
                    position: absolute;
                    top: 12px;
                    left: 50%;
                    transform: translateX(-50%);
                    display: flex;
                    gap: 8px;
                    z-index: 10;
                    pointer-events: none; /* Let container be passive */
                }

                /* ── Universal Liquid Glass Standard ── */
                .xiv-st-btn {
                    position: relative;
                    overflow: hidden;
                    border: none;
                    outline: none;
                    border-radius: 50%; /* Shape carries through to every layer */
                    width: 38px;
                    height: 38px;
                    font-size: 16px; /* Base for relative em scaling */
                    padding: 0;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    pointer-events: auto;
                    opacity: 0;

                    /* Frosted glass base */
                    background: rgba(255, 255, 255, 0.14);
                    backdrop-filter: blur(0.5em) saturate(180%) brightness(1.1);
                    -webkit-backdrop-filter: blur(0.5em) saturate(180%) brightness(1.1);

                    /* Layered inset highlights + ambient drop shadow */
                    box-shadow:
                        inset 0     0.09em 0    rgba(255,255,255,0.75),
                        inset 0    -0.09em 0    rgba(255,255,255,0.06),
                        inset  0.06em 0    0    rgba(255,255,255,0.30),
                        inset -0.06em 0    0    rgba(255,255,255,0.10),
                        0 0 0       0.03em      rgba(255,255,255,0.20),
                        0 0.4em     1.25em      rgba(0,0,0,0.32),
                        0 0.15em    0.4em       rgba(0,0,0,0.20);

                    /* Hardware acceleration to prevent Chromium blur-delay pop */
                    will-change: transform, opacity;
                    transform: translateZ(0);

                    transition:
                        opacity    0.2s  ease,
                        box-shadow 0.2s  ease,
                        background 0.2s  ease;
                }

                /* Reveal on hover */
                .download-items__thumb:hover .xiv-st-btn {
                    opacity: 1;
                }

                /* Gradient Border Ring (mask-composite trick) */
                .xiv-st-btn::before {
                    content: '';
                    position: absolute;
                    inset: 0;
                    border-radius: inherit;
                    padding: 0.06em;
                    background: linear-gradient(155deg, rgba(255,255,255,0.72) 0%, rgba(255,255,255,0.35) 25%, rgba(255,255,255,0.08) 55%, rgba(255,255,255,0.22) 100%);
                    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                    -webkit-mask-composite: xor;
                    mask-composite: exclude;
                    pointer-events: none;
                    z-index: 5;
                }

                /* Top Glare / Specular Highlight */
                .xiv-st-btn::after {
                    content: '';
                    position: absolute;
                    top: 0; left: 0; right: 0;
                    height: 58%;
                    background: radial-gradient(ellipse 75% 70% at 50% -8%, rgba(255,255,255,0.58) 0%, rgba(255,255,255,0.20) 40%, rgba(255,255,255,0.05) 70%, transparent 90%);
                    border-radius: inherit;
                    pointer-events: none;
                    z-index: 5;
                }

                /* Hover States */
                .xiv-st-btn:hover {
                    background: rgba(255, 255, 255, 0.22);
                    box-shadow:
                        inset 0     0.09em 0    rgba(255,255,255,0.85),
                        inset 0    -0.09em 0    rgba(255,255,255,0.08),
                        inset  0.06em 0    0    rgba(255,255,255,0.40),
                        inset -0.06em 0    0    rgba(255,255,255,0.14),
                        0 0 0       0.03em      rgba(255,255,255,0.28),
                        0 0.6em     1.8em       rgba(0,0,0,0.38),
                        0 0.2em     0.6em       rgba(0,0,0,0.22);
                }

                .xiv-st-btn:active {
                    box-shadow:
                        inset 0     0.09em 0    rgba(255,255,255,0.75),
                        inset 0    -0.09em 0    rgba(255,255,255,0.06),
                        inset  0.06em 0    0    rgba(255,255,255,0.30),
                        inset -0.06em 0    0    rgba(255,255,255,0.10),
                        0 0 0       0.03em      rgba(255,255,255,0.18),
                        0 0.2em     0.6em       rgba(0,0,0,0.25);
                }

                .xiv-st-btn[data-processing="1"] {
                    cursor: default !important;
                    pointer-events: none;
                }

                /* Inner Glass Depth Layers */
                .xiv-glass-lens {
                    position: absolute; inset: 0; border-radius: inherit;
                    background: radial-gradient(ellipse at 72% 56%, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.06) 45%, rgba(180,200,255,0.04) 80%, rgba(0,0,0,0) 100%);
                    pointer-events: none; z-index: 1;
                }
                .xiv-glass-scatter {
                    position: absolute; inset: 0.12em; border-radius: inherit;
                    background: radial-gradient(ellipse 60% 50% at 38% 40%, rgba(255,255,255,0.09) 0%, transparent 65%);
                    pointer-events: none; z-index: 2;
                }
                .xiv-glass-chroma {
                    position: absolute; inset: 0; border-radius: inherit;
                    background: radial-gradient(ellipse 100% 100% at 50% 50%, transparent 62%, rgba(80,200,255,0.09) 74%, rgba(255,80,100,0.07) 84%, transparent 92%);
                    pointer-events: none; z-index: 3;
                }
                .xiv-glass-rim {
                    position: absolute; bottom: 0; left: 10%; right: 10%; height: 40%;
                    border-radius: 0 0 inherit inherit;
                    background: radial-gradient(ellipse 80% 100% at 50% 115%, rgba(255,255,255,0.26) 0%, rgba(255,255,255,0.08) 45%, transparent 70%);
                    pointer-events: none; z-index: 4;
                }

                /* Morph Transitions & Content Layer */
                .xiv-icon-inner {
                    position: relative;
                    z-index: 6;
                    color: rgba(255, 255, 255, 0.96);
                    filter: drop-shadow(0 0 0.25em rgba(0,0,0,0.65)) drop-shadow(0 0.06em 0.19em rgba(0,0,0,0.50));
                    display: flex;
                    align-items: center; justify-content: center; width: 100%; height: 100%;
                    transition: opacity 0.15s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
                    transform-origin: center;
                }

                .xiv-icon-inner.xiv-morphing { opacity: 0; transform: scale(0.25) rotate(-45deg); }
                .xiv-icon-inner svg { width: 18px !important; height: 18px !important; display: block !important; }

                @keyframes xiv-spin { 100% { transform: rotate(360deg); } }
                .xiv-spinner { animation: xiv-spin 1s linear infinite; transform-origin: center; }
            `;
            (document.head || document.documentElement).appendChild(style);
        }

        function createIconElement(pathData) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.style.cssText = 'width:100%;height:100%;display:block;';
            svg.innerHTML = pathData;
            return svg;
        }

        function swapIconSmoothly(btn, newSvgPath) {
            let inner = btn.querySelector('.xiv-icon-inner');
            if (!inner) {
                inner = document.createElement('div');
                inner.className = 'xiv-icon-inner xiv-morphing';
                btn.appendChild(inner);
                void inner.offsetWidth; // Force reflow
            }

            return new Promise(resolve => {
                inner.classList.add('xiv-morphing');
                setTimeout(() => {
                    inner.replaceChildren(createIconElement(newSvgPath));
                    void inner.offsetWidth; // Force reflow
                    inner.classList.remove('xiv-morphing');
                    setTimeout(resolve, 250); // Morph IN duration
                }, 150); // Morph OUT duration
            });
        }

        function createCustomButton(svgPath, title, onClick) {
            const btn = document.createElement('button');
            btn.className = 'xiv-st-btn';
            btn.title = title;

            // Build the physical depth layers of the glass
            const lens = document.createElement('div'); lens.className = 'xiv-glass-lens';
            const scatter = document.createElement('div'); scatter.className = 'xiv-glass-scatter';
            const chroma = document.createElement('div'); chroma.className = 'xiv-glass-chroma';
            const rim = document.createElement('div'); rim.className = 'xiv-glass-rim';

            // The content layer wrapping the SVG icon
            const inner = document.createElement('div');
            inner.className = 'xiv-icon-inner';
            inner.appendChild(createIconElement(svgPath));

            // Stack them from bottom to top
            btn.append(lens, scatter, chroma, rim, inner);

            btn.onclick = onClick;
            return btn;
        }

        async function downloadBlob(url, filename, btn) {
            if (btn.dataset.processing === "1") return;
            btn.dataset.processing = "1";

            await swapIconSmoothly(btn, ST_ICONS.SPINNER);

            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                onload: async (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        const blobUrl = URL.createObjectURL(res.response);
                        const a = document.createElement('a');
                        a.href = blobUrl;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

                        await swapIconSmoothly(btn, ST_ICONS.CHECK);
                        setTimeout(async () => {
                            await swapIconSmoothly(btn, ST_ICONS.DOWNLOAD);
                            delete btn.dataset.processing;
                        }, 1000);
                    } else {
                        logger.error('Blob fetch failed with status:', res.status);
                        await swapIconSmoothly(btn, ST_ICONS.DOWNLOAD);
                        delete btn.dataset.processing;
                    }
                },
                onerror: async (err) => {
                    logger.error('Blob network error:', err);
                    await swapIconSmoothly(btn, ST_ICONS.DOWNLOAD);
                    delete btn.dataset.processing;
                }
            });
        }

        function observeAndInjectUI() {
            const stObserver = new MutationObserver(() => {
                const thumbs = document.querySelectorAll('.download-items__thumb:not([data-xiv-injected])');

                thumbs.forEach(thumb => {
                    thumb.dataset.xivInjected = 'true';

                    const img = thumb.querySelector('img');
                    if (!img || !img.src) return;

                    const container = document.createElement('div');
                    container.className = 'xiv-st-container';

                    const linkBtn = createCustomButton(ST_ICONS.LINK, 'Open in Background Tab', async (e) => {
                        e.preventDefault();
                        e.stopPropagation();

                        if (linkBtn.dataset.processing === "1") return;
                        linkBtn.dataset.processing = "1";

                        GM_openInTab(img.src, { active: false, insert: true });

                        await swapIconSmoothly(linkBtn, ST_ICONS.CHECK);
                        setTimeout(async () => {
                            await swapIconSmoothly(linkBtn, ST_ICONS.LINK);
                            delete linkBtn.dataset.processing;
                        }, 1000);
                    });

                    const dlBtn = createCustomButton(ST_ICONS.DOWNLOAD, 'Download Photo directly', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        // TikTok photos are typically JPEG/WEBP
                        const ext = img.src.includes('.webp') ? 'webp' : 'jpeg';
                        const filename = `tiktok-photo-${Date.now()}.${ext}`;
                        downloadBlob(img.src, filename, dlBtn);
                    });

                    container.append(linkBtn, dlBtn);
                    thumb.appendChild(container);
                });
            });

            stObserver.observe(document.body, { childList: true, subtree: true });
        }

        const executePhotoDownload = async () => {
            injectSaveTikTokEnhancements();
            observeAndInjectUI();

            const data = storage.get(CONFIG.storage.urlKey);
            if (!data || data.type !== 'photo') return;

            const url = data.url;
            logger.info('Starting automated form fill for photo:', url);
            storage.set(CONFIG.storage.urlKey, null);

            const broadcastState = (status) => {
                storage.set(CONFIG.storage.stateKey, { status, url, ts: Date.now() });
            };

            broadcastState('processing');

            try {
                // 1. Wait for form elements
                const input = await domUtils.waitForElement(CONFIG.selectors.savetiktok.input);
                const submitBtn = await domUtils.waitForElement(CONFIG.selectors.savetiktok.submit);

                // 2. Inject URL & Submit
                domUtils.setInputValue(input, url);
                await sleep(CONFIG.timeouts.actionWait);
                domUtils.simulateClick(submitBtn);

                // 3. Mark success and leave tab open so the user can select and download individual photos
                document.title = "Ready - Pick Photos";
                broadcastState('success');

            } catch (error) {
                logger.error('Automation aborted:', error.message);
                document.title = "❌ Form Error";
                broadcastState('error');
            }
        };

        executePhotoDownload();
    }
})();
