// ==UserScript==
// @name         [TikTok] Video Downloader
// @namespace    https://github.com/myouisaur/TikTok
// @icon         https://www.tiktok.com/favicon.ico
// @version      4.5
// @description  Adds a button to download TikTok videos via SnapTik.
// @author       Xiv
// @match        *://*.tiktok.com/*
// @match        *://snaptik.app/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @run-at       document-idle
// @updateURL    https://myouisaur.github.io/TikTok/downloader.user.js
// @downloadURL  https://myouisaur.github.io/TikTok/downloader.user.js
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        SNAPTIK_URL: 'https://snaptik.app/',
        STORED_LINK_KEY: 'tiktok_stored_link',
        DEBOUNCE_TIME_MS: 2000
    };

    // Centralized Fallback Selectors
    const SELECTORS = {
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
    };

    GM_addStyle(`
        .tiktok-downloader-btn {
            background: none;
            border: none;
            padding: 0;
            margin: 0;
            margin-bottom: 12px;
            display: flex;
            flex-direction: column;
            align-items: center;
            cursor: pointer;
            z-index: 999;
            opacity: 1;
            transition: opacity 0.2s ease;
        }

        .tiktok-downloader-btn.disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .downloader-icon-wrapper {
            width: 48px;
            height: 48px;
            background-color: #1F1F1F;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #E8E8E8;
            transition: background-color 0.2s ease, color 0.2s ease;
        }

        .tiktok-downloader-btn:not(.disabled):hover .downloader-icon-wrapper {
            background-color: #141414;
        }

        .tiktok-downloader-btn svg {
            width: 24px;
            height: 24px;
            fill: currentColor;
        }

        .tiktok-downloader-btn.success .downloader-icon-wrapper {
            background-color: #E8E8E8 !important;
            color: #1F1F1F !important;
        }

        .tiktok-downloader-btn.error .downloader-icon-wrapper {
            background-color: rgba(255, 59, 48, 0.9) !important;
            color: #fff;
        }
    `);

    let domObserver = null;
    let debounceTimer = null;
    let autoOpenObserver = null;
    let hasAttemptedAutoOpen = false;

    // --- Core Initialization ---
    function init() {
        if (window.location.hostname.includes('tiktok.com')) {
            setupZeroOverheadUrlTracker();
            handleRouteUpdate(); // Initial check on first load
            setupDebouncedObserver();
        } else if (window.location.hostname === 'snaptik.app') {
            initSnapTik();
        }
    }

    // --- Helper: Find Element via Fallbacks ---
    function findElement(selectorArray, parent = document) {
        for (const selector of selectorArray) {
            const el = parent.querySelector(selector);
            if (el) return el;
        }
        return null;
    }

    // --- Precise Link Extraction ---
    function getExactVideoLink(buttonElement) {
        try {
            const container = buttonElement.closest(SELECTORS.tiktok.postContainer);
            if (container) {
                const linkEl = container.querySelector(SELECTORS.tiktok.videoLink);
                if (linkEl && linkEl.href) {
                    return linkEl.href.split('?')[0];
                }
            }
        } catch (e) {
            console.warn('DOM link extraction failed. Falling back to URL bar.');
        }
        return window.location.href.split('?')[0];
    }

    // ==========================================
    // FACEBOOK-STYLE ROUTE TRACKER
    // ==========================================
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
        const isMainFeed = window.location.pathname === '/' ||
                           window.location.pathname.startsWith('/foryou') ||
                           window.location.pathname.startsWith('/following') ||
                           window.location.pathname.startsWith('/explore');

        // If the user navigates to a new feed (via sidebar), reset the auto-open rule
        if (isMainFeed) {
            hasAttemptedAutoOpen = false;

            // Clean up any lingering observer before starting a new one
            if (autoOpenObserver) {
                autoOpenObserver.disconnect();
                autoOpenObserver = null;
            }

            autoOpenCommentsOnce();
        }
    }

    // --- TikTok Logic ---

    // The Context-Aware Kickstart (Self-Killing Observer)
    function autoOpenCommentsOnce() {
        if (hasAttemptedAutoOpen) return;

        autoOpenObserver = new MutationObserver((mutations, obs) => {
            if (document.hidden) return;

            const commentBtn = findElement(SELECTORS.tiktok.commentBtn);
            if (commentBtn) {
                const commentsAreOpen = document.querySelector(SELECTORS.tiktok.commentsContainer) !== null;

                if (!commentsAreOpen) {
                    commentBtn.click();
                }

                // Immediately kill the observer so it never wastes CPU again
                hasAttemptedAutoOpen = true;
                obs.disconnect();
                autoOpenObserver = null;
            }
        });

        autoOpenObserver.observe(document.body, { childList: true, subtree: true });

        // Failsafe: Kill it after 10 seconds just in case it bugs out (e.g., extremely slow connection)
        setTimeout(() => {
            if (!hasAttemptedAutoOpen && autoOpenObserver) {
                hasAttemptedAutoOpen = true;
                autoOpenObserver.disconnect();
                autoOpenObserver = null;
            }
        }, 10000);
    }

    // --- Phase 3: The Zero-Polling UI Maintainer ---
    function setupDebouncedObserver() {
        if (domObserver) domObserver.disconnect();

        domObserver = new MutationObserver(() => {
            clearTimeout(debounceTimer);

            debounceTimer = setTimeout(() => {
                maintainUI();
            }, 250);
        });

        domObserver.observe(document.body, { childList: true, subtree: true });

        maintainUI();
    }

    function maintainUI() {
        const avatarLinks = document.querySelectorAll(SELECTORS.tiktok.avatar);

        avatarLinks.forEach(avatarLink => {
            const actionBar = avatarLink.closest('section');
            if (actionBar && !actionBar.querySelector('.tiktok-downloader-btn')) {
                const btn = document.createElement('button');
                btn.className = 'tiktok-downloader-btn';
                btn.type = 'button';
                btn.title = 'Download via SnapTik';
                btn.dataset.clicking = "false";

                btn.innerHTML = `
                    <span class="downloader-icon-wrapper">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                        </svg>
                    </span>
                `;

                btn.addEventListener('click', async function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    await handleButtonClick(this);
                });

                actionBar.insertBefore(btn, actionBar.firstChild);
            }
        });
    }

    async function handleButtonClick(clickedButton) {
        if (clickedButton.dataset.clicking === "true") return;
        clickedButton.dataset.clicking = "true";
        clickedButton.classList.add('disabled');

        const exactUrl = getExactVideoLink(clickedButton);
        let copiedSuccessfully = false;

        try {
            if (typeof GM_setClipboard !== 'undefined') {
                GM_setClipboard(exactUrl);
                copiedSuccessfully = true;
            } else {
                throw new Error("GM_setClipboard unavailable");
            }
        } catch (err) {
            try {
                await navigator.clipboard.writeText(exactUrl);
                copiedSuccessfully = true;
            } catch (fallbackErr) {
                console.error("TikTok Downloader: All clipboard methods failed", fallbackErr);
            }
        }

        if (copiedSuccessfully) {
            GM_setValue(CONFIG.STORED_LINK_KEY, exactUrl);
            clickedButton.classList.add('success');
            setTimeout(() => GM_openInTab(CONFIG.SNAPTIK_URL, { active: true, insert: true }), 150);
        } else {
            clickedButton.classList.add('error');
        }

        setTimeout(() => {
            clickedButton.classList.remove('success', 'error', 'disabled');
            clickedButton.dataset.clicking = "false";
        }, CONFIG.DEBOUNCE_TIME_MS);
    }

    // --- SnapTik Logic ---
    function checkSnapTikErrors() {
        const errorEl = findElement(SELECTORS.snaptik.captchaOrError);
        return errorEl !== null;
    }

    function initSnapTik() {
        const storedLink = GM_getValue(CONFIG.STORED_LINK_KEY);
        if (storedLink) {
            fillInputField(storedLink);
            GM_setValue(CONFIG.STORED_LINK_KEY, null);
        }
    }

    function fillInputField(url) {
        let attempts = 0;
        const maxAttempts = 60;

        const interval = setInterval(() => {
            if (checkSnapTikErrors()) {
                console.warn('SnapTik Downloader: Captcha or Error detected. Manual intervention required.');
                clearInterval(interval);
                return;
            }

            if (document.readyState === 'interactive' || document.readyState === 'complete') {
                const inputField = findElement(SELECTORS.snaptik.input);
                if (inputField) {
                    inputField.value = url;
                    inputField.focus();
                    inputField.dispatchEvent(new Event('input', { bubbles: true }));
                    inputField.dispatchEvent(new Event('change', { bubbles: true }));

                    clearInterval(interval);
                    clickDownloadButton();
                }
            }

            attempts++;
            if (attempts >= maxAttempts) clearInterval(interval);
        }, 500);
    }

    function clickDownloadButton() {
        setTimeout(() => {
            const downloadBtn = findElement(SELECTORS.snaptik.submit);
            if (downloadBtn) {
                downloadBtn.click();
                waitForFinalDownloadButton();
            }
        }, 500);
    }

    function waitForFinalDownloadButton() {
        let attempts = 0;
        const maxAttempts = 120;

        const interval = setInterval(() => {
            if (checkSnapTikErrors()) {
                clearInterval(interval);
                return;
            }

            const finalDownloadLink = findElement(SELECTORS.snaptik.download);
            if (finalDownloadLink) {
                clearInterval(interval);
                finalDownloadLink.click();
            }

            attempts++;
            if (attempts >= maxAttempts) clearInterval(interval);
        }, 500);
    }

    function cleanup() {
        if (domObserver) domObserver.disconnect();
        if (autoOpenObserver) autoOpenObserver.disconnect();
        clearTimeout(debounceTimer);
        document.querySelectorAll('.tiktok-downloader-btn').forEach(btn => btn.remove());
    }

    init();
    window.addEventListener('beforeunload', cleanup);

})();
