// ==UserScript==
// @name         [TikTok] Video Downloader
// @namespace    https://github.com/myouisaur/TikTok
// @icon         https://www.tiktok.com/favicon.ico
// @version      7.0
// @description  Adds a button to download TikTok videos via SSSTik in the background.
// @author       Xiv
// @match        *://*.tiktok.com/*
// @match        *://ssstik.io/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        window.close
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
            ssstik: 'https://ssstik.io/en'
        },
        storage: {
            urlKey: 'xiv_tiktok_stored_link',
            stateKey: 'xiv_ssstik_state'
        },
        classes: {
            btn: 'xiv-downloader-btn',
            wrapper: 'xiv-icon-wrapper',
            processedAvatar: 'xiv-processed-avatar'
        },
        ids: {
            style: 'xiv-styles'
        },
        colors: {
            bgNormal: '#1F1F1F',
            bgHover:  '#141414',
            bgActive: '#E8E8E8',
            bgError:  '#ff4444',
            fgNormal: '#E8E8E8',
            fgActive: '#1F1F1F',
            fgError:  '#FFFFFF'
        },
        selectors: {
            tiktok: {
                avatar: '[data-e2e="video-author-avatar"]',
                commentsContainer: '[data-e2e="video-comment-list"], [data-e2e="search-comment-container"], [data-e2e="comment-input"]',
                commentBtn: [
                    '[data-e2e="comment-icon"]',
                    'button[aria-label*="Read or add comments" i]',
                    'button strong[data-e2e="comment-count"]'
                ],
                postContainer: '[data-e2e="recommend-list-item-container"], [data-e2e="search-card"], [data-e2e="user-post-item"], .feed-item, [data-e2e="video-item"]',
                videoLink: 'a[href*="/video/"], a[href*="/t/"]'
            },
            ssstik: {
                input: ['#main_page_text'],
                submit: ['#submit'],
                download: ['a.without_watermark']
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
                .${CONFIG.classes.btn} {
                    background: none; border: none; padding: 0; margin: 0 0 12px 0;
                    display: flex; flex-direction: column; align-items: center;
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
                logger.warn('DOM link extraction failed. Falling back to URL bar.');
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
            const avatarLinks = document.querySelectorAll(`${CONFIG.selectors.tiktok.avatar}:not(.${CONFIG.classes.processedAvatar})`);

            avatarLinks.forEach(avatarLink => {
                avatarLink.classList.add(CONFIG.classes.processedAvatar);

                const actionBar = avatarLink.closest('section');
                if (actionBar && !actionBar.querySelector(`.${CONFIG.classes.btn}`)) {

                    const btn = document.createElement('button');
                    btn.className = CONFIG.classes.btn;
                    btn.type = 'button';
                    btn.title = 'Download via SSSTik';
                    btn.dataset.state = "idle";

                    const wrapper = document.createElement('span');
                    wrapper.className = CONFIG.classes.wrapper;
                    wrapper.appendChild(createDownloadIcon());
                    btn.appendChild(wrapper);

                    btn.onclick = (e) => {
                        e.preventDefault(); e.stopPropagation();
                        if (btn.dataset.state === 'processing') return;

                        const exactUrl = getExactVideoLink(btn);
                        btn.dataset.url = exactUrl;

                        storage.set(CONFIG.storage.urlKey, exactUrl);
                        btn.dataset.state = 'processing';

                        wrapper.style.backgroundColor = CONFIG.colors.bgActive;
                        wrapper.style.color = CONFIG.colors.fgActive;

                        setTimeout(() => {
                            GM_openInTab(CONFIG.urls.ssstik, { active: false, insert: true });
                        }, 500);
                    };

                    actionBar.insertBefore(btn, actionBar.firstChild);
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
    // SSSTIK MODULE (Background Tab)
    // ==========================================
    } else if (window.location.hostname.includes('ssstik.io')) {

        const executeDownload = async () => {
            const url = storage.get(CONFIG.storage.urlKey);
            if (!url) return;

            logger.info('Starting automated conversion for:', url);
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

        executeDownload();
    }
})();
