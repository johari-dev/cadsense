import { createCadRenderHost } from "./CadRenderHost";

/**
 * Entry for `render-host.html`, the page `cadsense mcp` opens in headless Chromium. It has no app
 * shell or RPC connection: the MCP process reads the server's render stream itself and passes
 * each event to `window.cadsenseRenderHost.accept`. Jobs then load and upload through the same
 * ticketed `/api/cad-render` routes a desktop window uses.
 */
Object.assign(window, { cadsenseRenderHost: createCadRenderHost(location.origin) });
