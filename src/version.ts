/**
 * Single source of truth for the engram version shown to users and stamped
 * into brain manifests, /health, MCP serverInfo, and the CLI banner.
 *
 * Keep in sync with package.json "version". Duplicating the string here
 * (instead of importing package.json) avoids emitting dist/package.json and
 * keeps the dist/ tree module-shaped.
 */
export const ENGRAM_VERSION = '0.1.0'
