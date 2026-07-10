// ==UserScript==
// @name         [TikTok] Video Downloader
// @namespace    https://github.com/myouisaur/TikTok
// @icon         https://www.tiktok.com/favicon.ico
// @version      5.0
// @description  Adds a button to download TikTok videos via SnapTik in the background.
// @author       Xiv
// @match        *://*.tiktok.com/*
// @match        *://snaptik.app/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        window.close
// @run-at       document-start
// @noframes
// @updateURL    https://myouisaur.github.io/TikTok/downloader.user.js
// @downloadURL  https://myouisaur.github.io/TikTok/downloader.user.js
// ==/UserScript==

(function() {
    'use strict';

    if (window.__tkDlInit) return;
    window.__tkDlInit = true;

    // ==========================================
    // CENTRALIZED CONFIGURATION
    // ==========================================
    const CONFIG = {
        debug: false,
        urls: {
            snaptik: 'https://snaptik.app/'
        },
        storage: {
            urlKey: 'tiktok_stored_link'
        },
        colors: {
            bgNormal: '#1F1F1F',
            bgHover:  '#141414',
            bgActive: '#E8E8E8',
            fgNormal: '#E8E8E8',
            fgActive: '#1F1F1F'
        },
        selectors: {
            tiktok: {
                avatar: '[data-e2e="video-author-avatar"]',
                commentsContainer: '[data-e2e="video-comment-list"], #search-comment-container, [data-e2e="search-comment-container"], [data-e2e="comment-input"]',
                commentBtn: [
                    'button[aria-label*="Read or add comments"]',
                    'button strong[data-e2e="comment-count"]',
                    'span[data-e2e="comment-icon"]',
                    'button.css-1ydks0-7937d88b--ButtonActionItem'
                ],
                postContainer: '[data-e2e="recommend-list-item-container"], [data-e2e="search-card"], [data-e2e="user-post-item"], .feed-item, [data-e2e="video-item"]',
                videoLink: 'a[href*="/video/"], a[href*="/t/"]'
            },
            snaptik: {
                input: ['#url', 'input[name="url"]', 'input[type="text"]', '.link-input'],
                submit: ['button[type="submit"].button-go', '.btn-submit', 'button[type="submit"]', '#submit'],
                download: ['a.button.download-file[data-event="server01_file"]', 'a.button.download-file', 'a[href*="dl.snaptik.app"]', '.download-link'],
                captchaOrError: ['iframe[src*="recaptcha"]', 'iframe[src*="turnstile"]', 'iframe[src*="hcaptcha"]', '.cf-turnstile', '.alert-danger', '.message-error']
            }
        },
        timeouts: {
            uiWait:        10000,
            dlMaxWait:     60000,
            tabCloseDelay: 2500,
            actionWait:    200
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

        // Modified for TikTok's fallback array selectors
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

                // documentElement guarantees it works at document-start before body exists
                observer.observe(document.documentElement, { childList: true, subtree: true });

                const timer = setTimeout(() => {
                    observer.disconnect();
                    reject(new Error(`Element(s) '${selectorArray.join(', ')}' not found`));
                }, timeoutMs);
            });
        }
    };

    const isCaptchaPresent = () => {
        for (const sel of CONFIG.selectors.snaptik.captchaOrError) {
            if (document.querySelector(sel)) return true;
        }
        return false;
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

        // Stylesheet Injection
        const styleId = 'tk-dl-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .tiktok-downloader-btn {
                    background: none; border: none; padding: 0; margin: 0 0 12px 0;
                    display: flex; flex-direction: column; align-items: center;
                    cursor: pointer; z-index: 999; opacity: 1;
                    transition: opacity 0.2s ease;
                }
                .tiktok-downloader-btn[data-state="processing"] {
                    opacity: 0.5; cursor: wait;
                }
                .downloader-icon-wrapper {
                    width: 48px; height: 48px;
                    background-color: ${CONFIG.colors.bgNormal};
                    border-radius: 50%; display: flex; align-items: center; justify-content: center;
                    color: ${CONFIG.colors.fgNormal};
                    transition: background-color 0.2s ease, color 0.2s ease;
                }
                .tiktok-downloader-btn:not([data-state="processing"]):hover .downloader-icon-wrapper {
                    background-color: ${CONFIG.colors.bgHover};
                }
                .tiktok-downloader-btn svg {
                    width: 24px; height: 24px; fill: currentColor;
                }
            `;
            // Safe append for document-start
            (document.head || document.documentElement).appendChild(style);
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
            const originalPushState = history.pushState;
            const originalReplaceState = history.replaceState;

            history.pushState = function() {
                originalPushState.apply(this, arguments);
                window.dispatchEvent(new Event('locationchange'));
            };

            history.replaceState = function() {
                originalReplaceState.apply(this, arguments);
                window.dispatchEvent(new Event('locationchange'));
            };

            window.addEventListener('popstate', () => {
                setTimeout(() => window.dispatchEvent(new Event('locationchange')), 50);
            });
            window.addEventListener('locationchange', handleRouteUpdate);
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
                    if (!commentsAreOpen) domUtils.simulateClick(commentBtn);

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

        function setupDebouncedObserver() {
            if (domObserver) domObserver.disconnect();

            domObserver = new MutationObserver(() => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(maintainUI, 250);
            });

            domObserver.observe(document.documentElement, { childList: true, subtree: true });
            maintainUI();
        }

        function maintainUI() {
            const avatarLinks = document.querySelectorAll(CONFIG.selectors.tiktok.avatar);

            avatarLinks.forEach(avatarLink => {
                const actionBar = avatarLink.closest('section');
                if (actionBar && !actionBar.querySelector('.tiktok-downloader-btn')) {

                    const btn = document.createElement('button');
                    btn.className = 'tiktok-downloader-btn';
                    btn.type = 'button';
                    btn.title = 'Download via SnapTik';
                    btn.dataset.state = "idle";

                    btn.innerHTML = `
                        <span class="downloader-icon-wrapper">
                            <svg viewBox="0 0 24 24" fill="currentColor">
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                            </svg>
                        </span>
                    `;

                    btn.onclick = (e) => {
                        e.preventDefault(); e.stopPropagation();
                        if (btn.dataset.state === 'processing') return;

                        const exactUrl = getExactVideoLink(btn);
                        storage.set(CONFIG.storage.urlKey, exactUrl);

                        btn.dataset.state = 'processing';
                        const wrapper = btn.querySelector('.downloader-icon-wrapper');
                        if (wrapper) {
                            wrapper.style.backgroundColor = CONFIG.colors.bgActive;
                            wrapper.style.color = CONFIG.colors.fgActive;
                        }

                        setTimeout(() => {
                            GM_openInTab(CONFIG.urls.snaptik, { active: false, insert: true });

                            btn.dataset.state = 'idle';
                            if (wrapper) {
                                wrapper.style.backgroundColor = '';
                                wrapper.style.color = '';
                            }
                        }, 500);
                    };

                    actionBar.insertBefore(btn, actionBar.firstChild);
                }
            });
        }

        // Initialize TikTok logic
        setupZeroOverheadUrlTracker();
        handleRouteUpdate();
        setupDebouncedObserver();

        window.addEventListener('beforeunload', () => {
            if (domObserver) domObserver.disconnect();
            if (autoOpenObserver) autoOpenObserver.disconnect();
            clearTimeout(debounceTimer);
        });

    // ==========================================
    // SNAPTIK MODULE (Background Tab)
    // ==========================================
    } else if (window.location.hostname === 'snaptik.app') {

        const executeDownload = async () => {
            const url = storage.get(CONFIG.storage.urlKey);
            if (!url) return;

            logger.info('Starting automated conversion for:', url);
            storage.set(CONFIG.storage.urlKey, null);

            try {
                // 1. Wait for elements
                const input = await domUtils.waitForElement(CONFIG.selectors.snaptik.input);
                const submitBtn = await domUtils.waitForElement(CONFIG.selectors.snaptik.submit);

                if (isCaptchaPresent()) throw new Error('captcha');

                // 2. Inject URL & Submit
                domUtils.setInputValue(input, url);
                await sleep(CONFIG.timeouts.actionWait);
                domUtils.simulateClick(submitBtn);

                // 3. Wait for the final download button
                document.title = "Processing...";
                const finalBtn = await domUtils.waitForElement(CONFIG.selectors.snaptik.download, CONFIG.timeouts.dlMaxWait);

                if (isCaptchaPresent()) throw new Error('captcha');

                // 4. Click Download & Cleanup
                document.title = "Downloading...";
                domUtils.simulateClick(finalBtn);

                setTimeout(() => window.close(), CONFIG.timeouts.tabCloseDelay);

            } catch (error) {
                logger.error('Automation aborted:', error.message);

                if (error.message.includes('captcha') || isCaptchaPresent()) {
                    document.title = "⚠️ Captcha Required!";
                } else if (error.message.includes('not found')) {
                    document.title = "❌ Conversion Timeout";
                }
            }
        };

        executeDownload();
    }
})();
