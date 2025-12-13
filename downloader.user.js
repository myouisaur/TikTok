// ==UserScript==
// @name         TikTok Video Downloader
// @namespace    https://github.com/myouisaur/TikTok
// @icon         https://www.tiktok.com/favicon.ico
// @version      3.0
// @description  Adds a floating button to send TikTok videos to SnapTik for easy downloading
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

    // Configuration
    const CONFIG = {
        SNAPTIK_URL: 'https://snaptik.app/',
        STORED_LINK_KEY: 'tiktok_stored_link'
    };

    // Add styles - positioned to avoid TikTok's right sidebar
    GM_addStyle(`
        @keyframes colorCycle {
            0%, 100% {
                background-color: rgba(254, 44, 85, 0.9);
            }
            50% {
                background-color: rgba(37, 244, 238, 0.9);
            }
        }

        #tiktok-downloader-btn {
            position: fixed;
            top: 15px;
            left: 200px;
            width: 48px;
            height: 48px;
            background-color: rgba(254, 44, 85, 0.9);
            color: #ffffff;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
            z-index: 9999;
            user-select: none;
            animation: colorCycle 3s ease-in-out infinite !important;
        }

        #tiktok-downloader-btn:hover {
            animation-play-state: paused !important;
            transform: scale(1.05);
        }

        #tiktok-downloader-btn svg {
            width: 22px;
            height: 22px;
            fill: currentColor;
        }

        #tiktok-downloader-btn.success {
            background-color: rgba(37, 244, 238, 0.9) !important;
            animation: none !important;
        }

        #tiktok-downloader-btn.success:hover {
            background-color: rgba(37, 244, 238, 1) !important;
        }
    `);

    // State management
    let button = null;
    let urlObserver = null;
    let commentCheckInterval = null;
    let commentStateObserver = null;
    let userCommentPreference = 'auto'; // 'auto', 'open', 'closed'
    let hasAutoOpenedOnce = false;
    let lastKnownPath = ''; // Track the last path before navigation

    // Initialize based on current site
    function init() {
        if (window.location.hostname.includes('tiktok.com')) {
            // Always monitor URL changes on TikTok
            monitorUrlChanges();

            // Monitor comment section state
            monitorCommentSection();

            // Check if on main feed and auto-open comments (first time only)
            if (isOnMainFeed()) {
                autoOpenComments();
            }

            // Show button if starting on a video page
            if (isOnVideoPage()) {
                createFloatingButton();
            }
        } else if (window.location.hostname === 'snaptik.app') {
            initSnapTik();
        }
    }

    // Check if currently on a video page
    function isOnVideoPage() {
        const hostname = window.location.hostname;
        const pathname = window.location.pathname;

        return hostname.includes('tiktok.com') &&
               (pathname.includes('/@') && pathname.includes('/video/') ||
                pathname.startsWith('/t/'));
    }

    // Check if on main TikTok feed (anything that's NOT a video page)
    function isOnMainFeed() {
        return !isOnVideoPage();
    }

    // Auto-open comments section on main feed
    function autoOpenComments() {
        // Don't auto-open if user explicitly closed comments
        if (userCommentPreference === 'closed') {
            console.log('User closed comments, not auto-opening');
            return;
        }

        // Clear any existing interval
        if (commentCheckInterval) {
            clearInterval(commentCheckInterval);
            commentCheckInterval = null;
        }

        console.log('Starting auto-open comments...');

        const maxAttempts = 40;
        let attempts = 0;

        commentCheckInterval = setInterval(() => {
            attempts++;

            // Try multiple selectors to find the comment button
            const commentBtn =
                document.querySelector('button[aria-label*="Read or add comments"]') ||
                document.querySelector('button strong[data-e2e="comment-count"]')?.closest('button') ||
                document.querySelector('span[data-e2e="comment-icon"]')?.closest('button') ||
                document.querySelector('button.css-1ydks0-7937d88b--ButtonActionItem');

            if (commentBtn) {
                console.log('Comment button found on attempt', attempts, commentBtn);
                clearInterval(commentCheckInterval);
                commentCheckInterval = null;

                // Small delay before clicking to ensure everything is ready
                setTimeout(() => {
                    commentBtn.click();
                    console.log('Comment button clicked (auto)');
                    userCommentPreference = 'open';
                    hasAutoOpenedOnce = true;

                    // After clicking comments, check for video page URL change
                    checkForVideoPageAfterComment();
                }, 100);
                return;
            }

            if (attempts >= maxAttempts) {
                console.warn('Comment button not found after', maxAttempts, 'attempts (20 seconds)');
                clearInterval(commentCheckInterval);
                commentCheckInterval = null;
            }
        }, 500);
    }

    // Monitor URL changes for single-page app navigation
    function monitorUrlChanges() {
        // Disconnect existing observer if any
        if (urlObserver) {
            urlObserver.disconnect();
        }

        let lastUrl = window.location.href;

        urlObserver = new MutationObserver(() => {
            const currentUrl = window.location.href;
            if (currentUrl !== lastUrl) {
                lastUrl = currentUrl;
                handleUrlChange();
            }
        });

        // Use throttled observation to reduce CPU usage
        urlObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function handleUrlChange() {
        // Clear any running comment check interval when URL changes
        if (commentCheckInterval) {
            clearInterval(commentCheckInterval);
            commentCheckInterval = null;
        }

        const currentUrl = window.location.href;
        const currentPath = window.location.pathname;

        console.log('URL changed to:', currentUrl);
        console.log('User comment preference:', userCommentPreference);
        console.log('Has auto opened once:', hasAutoOpenedOnce);

        const nowOnMainFeed = isOnMainFeed();
        const nowOnVideoPage = isOnVideoPage();

        if (nowOnVideoPage) {
            console.log('On video page, creating button...');
            // Show button if it doesn't exist
            if (!document.getElementById('tiktok-downloader-btn')) {
                createFloatingButton();
            }
            // Update preference only if it was 'auto'
            if (userCommentPreference === 'auto') {
                userCommentPreference = 'open';
            }
        } else if (nowOnMainFeed) {
            // Only auto-open on very first time
            if (!hasAutoOpenedOnce && userCommentPreference !== 'closed') {
                console.log('Auto-opening comments (FIRST TIME ONLY)');
                hasAutoOpenedOnce = true; // Set BEFORE calling autoOpenComments
                autoOpenComments();
            } else {
                console.log('Not auto-opening - hasAutoOpenedOnce:', hasAutoOpenedOnce, 'preference:', userCommentPreference);
                removeButton();
            }
        } else {
            // Hide button when not on video page
            removeButton();
        }
    }

    function createFloatingButton() {
        // Avoid duplicate buttons
        if (document.getElementById('tiktok-downloader-btn')) return;

        button = document.createElement('div');
        button.id = 'tiktok-downloader-btn';
        button.innerHTML = `
            <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
        `;
        button.title = 'Download TikTok Video';

        // Click handler
        button.addEventListener('click', handleButtonClick);

        document.body.appendChild(button);
    }

    function handleButtonClick() {
        const currentUrl = window.location.href;

        // Copy to clipboard
        GM_setClipboard(currentUrl);

        // Store the link
        GM_setValue(CONFIG.STORED_LINK_KEY, currentUrl);

        // Visual feedback
        button.classList.add('success');
        button.title = 'Link copied!';
        setTimeout(() => {
            button.classList.remove('success');
            button.title = 'Download TikTok Video';
        }, 300);

        // Open SnapTik in new tab
        GM_openInTab(CONFIG.SNAPTIK_URL, { active: true, insert: true });
    }

    // SnapTik functionality
    function initSnapTik() {
        const storedLink = GM_getValue(CONFIG.STORED_LINK_KEY);

        if (storedLink) {
            fillInputField(storedLink);
            // Clear stored link after use
            GM_setValue(CONFIG.STORED_LINK_KEY, null);
        }
    }

    function fillInputField(url) {
        // Wait for the input field to be available
        const maxAttempts = 20;
        let attempts = 0;

        const interval = setInterval(() => {
            const inputField = document.getElementById('url');

            if (inputField) {
                inputField.value = url;
                inputField.focus();

                // Trigger input event for any listeners
                inputField.dispatchEvent(new Event('input', { bubbles: true }));
                inputField.dispatchEvent(new Event('change', { bubbles: true }));

                clearInterval(interval);

                // Click the Download button after filling
                clickDownloadButton();
            }

            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(interval);
                console.warn('SnapTik input field not found');
            }
        }, 200);
    }

    function clickDownloadButton() {
        // Wait a moment for the page to process the input
        setTimeout(() => {
            const downloadBtn = document.querySelector('button[type="submit"].button-go');

            if (downloadBtn) {
                downloadBtn.click();

                // Wait for the second download button to appear
                waitForFinalDownloadButton();
            } else {
                console.warn('Download button not found');
            }
        }, 500);
    }

    function waitForFinalDownloadButton() {
        // Wait for the final download link to appear after processing
        const maxAttempts = 30;
        let attempts = 0;

        const interval = setInterval(() => {
            const finalDownloadLink = document.querySelector('a.button.download-file[data-event="server01_file"]');

            if (finalDownloadLink) {
                clearInterval(interval);
                // Click the final download link
                finalDownloadLink.click();
            }

            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(interval);
                console.warn('Final download button not found');
            }
        }, 300);
    }

    // Check if URL changed to video page after clicking comments
    function checkForVideoPageAfterComment() {
        const maxAttempts = 30;
        let attempts = 0;

        const checkInterval = setInterval(() => {
            attempts++;

            if (isOnVideoPage()) {
                console.log('Video page detected after comment click');
                clearInterval(checkInterval);

                // Create button if it doesn't exist - with a small delay to ensure DOM is ready
                setTimeout(() => {
                    if (!document.getElementById('tiktok-downloader-btn')) {
                        console.log('Creating button after video page detection');
                        createFloatingButton();
                    }
                }, 200);
            }

            if (attempts >= maxAttempts) {
                clearInterval(checkInterval);
                console.warn('Video page not detected after comment click');
            }
        }, 300);
    }

    // Monitor comment section state (open/closed)
    function monitorCommentSection() {
        if (commentStateObserver) {
            commentStateObserver.disconnect();
        }

        let lastPath = window.location.pathname;

        commentStateObserver = new MutationObserver(() => {
            const currentPath = window.location.pathname;

            // Detect when user manually closes comments (video page → main feed)
            if (lastPath.includes('/video/') && !currentPath.includes('/video/')) {
                console.log('User closed comments manually - setting preference to closed');
                userCommentPreference = 'closed';
                hasAutoOpenedOnce = true; // Ensure we never auto-open again
                removeButton();
            }

            // Detect when user manually opens comments (main feed → video page)
            else if (!lastPath.includes('/video/') && currentPath.includes('/video/')) {
                console.log('User opened comments manually - setting preference to open');
                userCommentPreference = 'open';
                if (!document.getElementById('tiktok-downloader-btn')) {
                    createFloatingButton();
                }
            }

            lastPath = currentPath;
        });

        commentStateObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // Cleanup function to prevent memory leaks
    function cleanup() {
        removeButton();

        // Clear comment check interval
        if (commentCheckInterval) {
            clearInterval(commentCheckInterval);
            commentCheckInterval = null;
        }

        // Disconnect observers
        if (urlObserver) {
            urlObserver.disconnect();
            urlObserver = null;
        }

        if (commentStateObserver) {
            commentStateObserver.disconnect();
            commentStateObserver = null;
        }
    }

    function removeButton() {
        if (button && button.parentNode) {
            button.removeEventListener('click', handleButtonClick);
            button.remove();
            button = null;
        }
    }

    // Initialize on page load
    init();

    // Cleanup on page unload
    window.addEventListener('beforeunload', cleanup);

})();
