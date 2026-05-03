// ==UserScript==
// @name         [TikTok] Video Downloader
// @namespace    https://github.com/myouisaur/TikTok
// @icon         https://www.tiktok.com/favicon.ico
// @version      4.2
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

    // Centralized Fallback Selectors (Future-Proofing)
    const SELECTORS = {
        tiktok: {
            avatar: '[data-e2e="video-author-avatar"]',
            postContainer: '[data-e2e="recommend-list-item-container"], [data-e2e="search-card"], [data-e2e="user-post-item"], .feed-item, [data-e2e="video-item"]',
            videoLink: 'a[href*="/video/"], a[href*="/t/"]',
            commentBtn: [
                'button[aria-label*="Read or add comments"]',
                'button strong[data-e2e="comment-count"]',
                'span[data-e2e="comment-icon"]',
                'button.css-1ydks0-7937d88b--ButtonActionItem'
            ]
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

        /* Status States */
        .tiktok-downloader-btn.success .downloader-icon-wrapper {
            background-color: #E8E8E8 !important; /* Swapped background */
            color: #1F1F1F !important; /* Swapped icon color */
        }

        .tiktok-downloader-btn.error .downloader-icon-wrapper {
            background-color: rgba(255, 59, 48, 0.9) !important; /* Warning Red */
            color: #fff;
        }
    `);

    let urlObserver = null;
    let commentCheckInterval = null;
    let commentStateObserver = null;
    let userCommentPreference = 'auto';
    let lastKnownPath = '';

    // --- Core Initialization ---
    function init() {
        if (window.location.hostname.includes('tiktok.com')) {
            lastKnownPath = window.location.pathname;
            monitorUrlChanges();
            monitorCommentSection();

            // Tab Visibility API (Global Cleanup/Pause)
            document.addEventListener("visibilitychange", handleVisibilityChange);

            if (isOnMainFeed()) autoOpenComments();
            if (isOnVideoPage()) createFloatingButton();
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

    // --- Tab Visibility Hook ---
    function handleVisibilityChange() {
        if (document.hidden) {
            // Stop aggressive polling while tab is inactive
            if (commentCheckInterval) {
                clearInterval(commentCheckInterval);
                commentCheckInterval = null;
            }
        } else {
            // Re-sync state when user comes back
            handleUrlChange();
        }
    }

    // --- Routing Checks ---
    function isOnVideoPage() {
        return window.location.pathname.includes('/video/') || window.location.pathname.startsWith('/t/');
    }

    function isOnMainFeed() {
        return !isOnVideoPage();
    }

    // --- Precise Link Extraction ---
    function getExactVideoLink(buttonElement) {
        try {
            // 1. Traverse up to the main post container
            const container = buttonElement.closest(SELECTORS.tiktok.postContainer);
            if (container) {
                // 2. Find the anchor link inside this specific container
                const linkEl = container.querySelector(SELECTORS.tiktok.videoLink);
                if (linkEl && linkEl.href) {
                    // Strip tracking parameters (?is_from_webapp...) for a clean link
                    return linkEl.href.split('?')[0];
                }
            }
        } catch (e) {
            console.warn('DOM link extraction failed. Falling back to URL bar.');
        }
        // Fallback: Just grab the URL bar link (stripped of params)
        return window.location.href.split('?')[0];
    }

    // --- TikTok Logic ---
    function autoOpenComments() {
        if (userCommentPreference === 'closed' || document.hidden) return;
        if (commentCheckInterval) clearInterval(commentCheckInterval);

        let attempts = 0;
        const maxAttempts = 40;

        commentCheckInterval = setInterval(() => {
            if (document.hidden) return; // Pause if user tabs out
            attempts++;

            const commentBtn = findElement(SELECTORS.tiktok.commentBtn);
            if (commentBtn) {
                clearInterval(commentCheckInterval);
                commentCheckInterval = null;
                setTimeout(() => {
                    commentBtn.click();
                    userCommentPreference = 'open';
                    checkForVideoPageAfterComment();
                }, 100);
                return;
            }

            if (attempts >= maxAttempts) {
                clearInterval(commentCheckInterval);
                commentCheckInterval = null;
            }
        }, 500);
    }

    function monitorUrlChanges() {
        if (urlObserver) urlObserver.disconnect();
        let lastUrl = window.location.href;

        urlObserver = new MutationObserver(() => {
            if (document.hidden) return; // Ignore DOM noise while hidden
            const currentUrl = window.location.href;
            if (currentUrl !== lastUrl) {
                lastUrl = currentUrl;
                handleUrlChange();
            }
        });

        urlObserver.observe(document.body, { childList: true, subtree: true });
    }

    function handleUrlChange() {
        if (commentCheckInterval) {
            clearInterval(commentCheckInterval);
            commentCheckInterval = null;
        }

        const currentPath = window.location.pathname;
        const nowOnMainFeed = isOnMainFeed();
        const nowOnVideoPage = isOnVideoPage();

        if (nowOnMainFeed && lastKnownPath !== currentPath && !lastKnownPath.includes('/video/')) {
            userCommentPreference = 'auto';
        }
        lastKnownPath = currentPath;

        if (nowOnVideoPage) {
            createFloatingButton();
            if (userCommentPreference === 'auto') userCommentPreference = 'open';
        } else if (nowOnMainFeed) {
            if (userCommentPreference !== 'closed') autoOpenComments();
            else removeButton();
        } else {
            removeButton();
        }
    }

    function createFloatingButton() {
        let attempts = 0;
        const maxAttempts = 10;

        const tryInsert = () => {
            const avatarLinks = document.querySelectorAll(SELECTORS.tiktok.avatar);
            let insertedSomething = false;

            avatarLinks.forEach(avatarLink => {
                const actionBar = avatarLink.closest('section');
                if (actionBar && !actionBar.querySelector('.tiktok-downloader-btn')) {
                    const btn = document.createElement('button');
                    btn.className = 'tiktok-downloader-btn';
                    btn.type = 'button';
                    btn.title = 'Download via SnapTik';
                    btn.dataset.clicking = "false"; // Debounce state

                    btn.innerHTML = `
                        <span class="downloader-icon-wrapper">
                            <svg viewBox="0 0 24 24" fill="currentColor">
                                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                            </svg>
                        </span>
                    `;

                    btn.addEventListener('click', function(e) {
                        e.preventDefault();
                        handleButtonClick(this);
                    });

                    actionBar.insertBefore(btn, actionBar.firstChild);
                    insertedSomething = true;
                }
            });

            if (!insertedSomething && attempts < maxAttempts) {
                attempts++;
                setTimeout(tryInsert, 500);
            }
        };

        tryInsert();
    }

    function handleButtonClick(clickedButton) {
        // Spam Prevention
        if (clickedButton.dataset.clicking === "true") return;
        clickedButton.dataset.clicking = "true";
        clickedButton.classList.add('disabled');

        const exactUrl = getExactVideoLink(clickedButton);

        try {
            // Attempt Clipboard API
            GM_setClipboard(exactUrl);
            GM_setValue(CONFIG.STORED_LINK_KEY, exactUrl);

            // Success State (Visual swap)
            clickedButton.classList.add('success');

            setTimeout(() => {
                GM_openInTab(CONFIG.SNAPTIK_URL, { active: true, insert: true });
            }, 150);

        } catch (err) {
            // Graceful Failure State (Red icon)
            console.error("TikTok Downloader: Clipboard error", err);
            clickedButton.classList.add('error');
        }

        // Debounce Reset
        setTimeout(() => {
            clickedButton.classList.remove('success', 'error', 'disabled');
            clickedButton.dataset.clicking = "false";
        }, CONFIG.DEBOUNCE_TIME_MS);
    }

    function checkForVideoPageAfterComment() {
        let attempts = 0;
        const checkInterval = setInterval(() => {
            attempts++;
            if (isOnVideoPage()) {
                clearInterval(checkInterval);
                setTimeout(createFloatingButton, 200);
            }
            if (attempts >= 30) clearInterval(checkInterval);
        }, 300);
    }

    function monitorCommentSection() {
        if (commentStateObserver) commentStateObserver.disconnect();
        let lastPath = window.location.pathname;

        commentStateObserver = new MutationObserver(() => {
            if (document.hidden) return;
            const currentPath = window.location.pathname;

            if (lastPath.includes('/video/') && !currentPath.includes('/video/')) {
                userCommentPreference = 'closed';
                removeButton();
            } else if (!lastPath.includes('/video/') && currentPath.includes('/video/')) {
                userCommentPreference = 'open';
                createFloatingButton();
            }
            lastPath = currentPath;
        });

        commentStateObserver.observe(document.body, { childList: true, subtree: true });
    }

    function removeButton() {
        document.querySelectorAll('.tiktok-downloader-btn').forEach(btn => btn.remove());
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
        const maxAttempts = 60; // 30 seconds

        const interval = setInterval(() => {
            // Captcha/Error Halt
            if (checkSnapTikErrors()) {
                console.warn('SnapTik Downloader: Captcha or Error detected. Manual intervention required.');
                clearInterval(interval);
                return;
            }

            // Only proceed if DOM is somewhat stable
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
        const maxAttempts = 120; // Up to 60 seconds of waiting for processing

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

    // --- Cleanup ---
    function cleanup() {
        removeButton();
        if (commentCheckInterval) clearInterval(commentCheckInterval);
        if (urlObserver) urlObserver.disconnect();
        if (commentStateObserver) commentStateObserver.disconnect();
        document.removeEventListener("visibilitychange", handleVisibilityChange);
    }

    init();
    window.addEventListener('beforeunload', cleanup);

})();
