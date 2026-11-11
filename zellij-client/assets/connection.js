/**
 * Connection-related utility functions and management
 */

import { getBaseUrl } from "./utils.js";

// Connection state
let reconnectionAttempt = 0;
let isReconnecting = false;
let isDisconnected = false;
let reconnectionTimeout = null;
let hasConnectedBefore = false;
let isPageUnloading = false;
let reconnectHandler = null;
let indicatorPosition = null;

/**
 * Get the delay for reconnection attempts using exponential backoff
 * @param {number} attempt - The current attempt number (1-based)
 * @returns {number} The delay in seconds
 */
export function getReconnectionDelay(attempt) {
    const delays = [1, 2, 4, 8, 16];
    return delays[Math.min(attempt - 1, delays.length - 1)];
}

/**
 * Check if the server connection is available
 * @returns {Promise<boolean>} true if connection is OK, false otherwise
 */
export async function checkConnection() {
    try {
        const baseUrl = getBaseUrl();
        const response = await fetch(`${baseUrl}/info/version`, {
            method: "GET",
            timeout: 5000,
        });
        return response.ok;
    } catch (error) {
        return false;
    }
}

/**
 * Handle intentional disconnection by the host (close code 4001)
 * @returns {Promise<void>}
 */
export async function handleDisconnected() {
    if (isDisconnected || isPageUnloading) {
        return;
    }
    isDisconnected = true;
    await showErrorModal("Disconnected", "You have been disconnected by the host.");
    isDisconnected = false;
}

/**
 * Register the function that re-opens the session in place (new websockets on
 * the existing terminal) so a reconnect does not need a page reload.
 * @param {function(): Promise<void>} fn
 */
export function setReconnectHandler(fn) {
    reconnectHandler = fn;
}

/**
 * Handle reconnection attempts with exponential backoff
 * @param {Terminal} term - The xterm.js instance
 * @returns {Promise<void>}
 */
export async function handleReconnection(term) {
    if (isReconnecting || !hasConnectedBefore || isPageUnloading) {
        return;
    }

    isReconnecting = true;
    indicatorPosition = null;

    // Low-profile reconnection: no modal. Show a red countdown next to the
    // "Zellij (session)" label and retry in the background with exponential
    // backoff, retrying right away when the browser comes back online or the
    // tab becomes visible again.
    while (isReconnecting && !isPageUnloading) {
        reconnectionAttempt++;
        const attempt = reconnectionAttempt;
        const delaySeconds = getReconnectionDelay(attempt);
        const suffix = attempt > 1 ? ` (attempt ${attempt})` : "";

        await waitForRetry(delaySeconds, (remaining) => {
            showReconnectingIndicator(term, `Reconnecting in ${remaining}s${suffix}`);
        });
        if (isPageUnloading) {
            return;
        }

        showReconnectingIndicator(term, `Reconnecting...${suffix}`);
        if (!(await checkConnection())) {
            continue;
        }

        if (reconnectHandler) {
            try {
                // The server redraws the whole screen on attach, so this
                // replaces the frozen screen without a page reload.
                await reconnectHandler();
                isReconnecting = false;
                reconnectionAttempt = 0;
                return;
            } catch (error) {
                console.warn("zellij: in-place reconnect failed, reloading", error);
            }
        }
        isReconnecting = false;
        reconnectionAttempt = 0;
        window.location.reload();
        return;
    }
}

const INDICATOR_WIDTH = 32;

/**
 * Draw a red status label into the terminal, right after the
 * "Zellij (session)" label of the tab bar, using that bar's background.
 * Falls back to the top-right corner of the first row when there is no such
 * label (e.g. no tab bar). While disconnected nothing else draws to the
 * screen, and the server's redraw replaces it after reconnecting.
 * @param {Terminal} term - The xterm.js instance
 * @param {string} label - Text to show
 */
function showReconnectingIndicator(term, label) {
    if (!term) {
        return;
    }
    if (!indicatorPosition) {
        indicatorPosition = findIndicatorPosition(term);
    }
    const { col, bg } = indicatorPosition;
    const width = Math.max(0, Math.min(INDICATOR_WIDTH, term.cols - col + 1));
    const text = label.padEnd(width).slice(0, width);
    // save cursor, move to row 1, red on the bar's background, reset, restore
    term.write(`\x1b7\x1b[1;${col}H\x1b[0;31${bg}m${text}\x1b[0m\x1b8`);
}

/**
 * Find where to draw the indicator, and the background color there
 * @param {Terminal} term - The xterm.js instance
 * @returns {{col: number, bg: string}} 1-based column and SGR bg params
 */
function findIndicatorPosition(term) {
    let col = Math.max(1, term.cols - INDICATOR_WIDTH + 1);
    let bg = "";
    try {
        const buffer = term.buffer.active;
        const firstRow = buffer.getLine(buffer.viewportY);
        const text = firstRow ? firstRow.translateToString(true) : "";
        const match = text.match(/Zellij \([^)]*\)/);
        if (match) {
            const end = match.index + match[0].length; // 0-based cell after ")"
            col = end + 2; // 1-based, leaving one space
            const cell = firstRow.getCell(end);
            if (cell && cell.isBgRGB()) {
                const c = cell.getBgColor();
                bg = `;48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`;
            } else if (cell && cell.isBgPalette()) {
                bg = `;48;5;${cell.getBgColor()}`;
            }
        }
    } catch (e) {
        // keep the fallback position
    }
    return { col, bg };
}

/**
 * Count down the given number of seconds, calling onTick with the seconds
 * remaining; ends early if the browser comes back online or the page becomes
 * visible
 * @param {number} seconds
 * @param {function(number): void} onTick
 * @returns {Promise<void>}
 */
function waitForRetry(seconds, onTick) {
    return new Promise((resolve) => {
        let remaining = seconds;
        const done = () => {
            clearInterval(reconnectionTimeout);
            reconnectionTimeout = null;
            window.removeEventListener("online", done);
            document.removeEventListener("visibilitychange", onVisible);
            resolve();
        };
        const onVisible = () => {
            if (document.visibilityState === "visible") done();
        };
        onTick(remaining);
        reconnectionTimeout = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                done();
            } else {
                onTick(remaining);
            }
        }, 1000);
        window.addEventListener("online", done);
        document.addEventListener("visibilitychange", onVisible);
    });
}

/**
 * Initialize connection handlers and event listeners
 */
export function initConnectionHandlers() {
    window.addEventListener("beforeunload", () => {
        isPageUnloading = true;
    });

    window.addEventListener("pagehide", () => {
        isPageUnloading = true;
    });
}

/**
 * Mark that a connection has been established
 */
export function markConnectionEstablished() {
    hasConnectedBefore = true;
}

/**
 * Reset connection state
 */
export function resetConnectionState() {
    reconnectionAttempt = 0;
    isReconnecting = false;
    isDisconnected = false;
    reconnectionTimeout = null;
    hasConnectedBefore = false;
    isPageUnloading = false;
}
