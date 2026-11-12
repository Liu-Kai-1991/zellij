import { initConnectionHandlers, setReconnectHandler } from './connection.js';
import { fetchSession, fetchSessionList } from './auth.js';
import { initTerminal, settleFontSize } from './terminal.js';
import { setupInputHandlers } from './input.js';
import { initWebSockets, getLastActivePane } from './websockets.js';
import {
    initMobileUi,
    shouldUseStandaloneMenu,
    showStandaloneSessionMenu,
} from './mobile-ui.js';

document.addEventListener("DOMContentLoaded", async (event) => {
    initConnectionHandlers();

    const sessionFromPath = location.pathname.split("/").pop();

    // A session name in the path is an explicit request for that session; only the bare root,
    // which would otherwise boot a welcome session, is replaced by the session menu.
    let welcome = true;
    if (!sessionFromPath && shouldUseStandaloneMenu()) {
        document.title = "Zellij";
        await showStandaloneSessionMenu({ fetchSessions: fetchSessionList });
        welcome = false;
    }

    const boot = await fetchSession(sessionFromPath, { welcome });

    if (!location.pathname.endsWith(`/${boot.session_name}`)) {
        history.replaceState(null, "", boot.session_name);
    }

    const { term, fitAddon } = initTerminal(boot.config);
    settleFontSize(term, fitAddon, boot.config);

    let websockets = null;
    initMobileUi({
        term,
        fitAddon,
        getSendAnsiKey: () => (websockets ? websockets.sendAnsiKey : () => {}),
    });

    document.title = boot.session_name;
    websockets = initWebSockets(boot, term, fitAddon);

    // Reconnect in place (fresh session handshake + new websockets on the
    // same terminal) instead of reloading the page, which makes the screen blink
    setReconnectHandler(async () => {
        // Rejoin the session in the URL, like a reload would: it follows
        // SwitchedSession, whereas boot.session_name is the session this page
        // first opened (e.g. the welcome session)
        let currentSession = boot.session_name;
        try {
            currentSession =
                decodeURIComponent(location.pathname.split("/").pop()) || boot.session_name;
        } catch (e) {
            // malformed URL: keep the boot session
        }
        const freshBoot = await fetchSession(currentSession, { welcome: false });
        if (!freshBoot || !freshBoot.web_client_id) {
            throw new Error("no web client id in session response");
        }
        websockets.cleanup();
        // Only restore the pane when rejoining the same session
        const lastPane = getLastActivePane();
        const restorePane =
            lastPane && lastPane.session_name === currentSession ? lastPane : null;
        websockets = initWebSockets(freshBoot, term, fitAddon, {
            clearOnFirstMessage: true,
            restorePane,
        });
    });

    setupInputHandlers(term, fitAddon, (data) => websockets.sendAnsiKey(data));
});
