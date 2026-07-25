'use strict';

// The entire desktop surface exposed to the page.
//
// Three methods, no `fs`, no path handling, no file contents. The renderer talks to the
// server over WebSocket exactly as the browser does (renderer/client.js), so the only
// things that need a native process are the ones a web page genuinely cannot do: open a
// file picker, and ask whether the server is back.
//
// The legacy preload.js exposed thirteen methods including the whole pty lifecycle. That
// surface is gone -- server.js owns it now, for both front-ends.
//
// This runs against a page loaded over http://, which is exactly what contextBridge is
// for: the preload executes in the isolated world before any page script, regardless of
// the URL scheme.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ganglionDesktop', {
  // Feature-detection flag. renderer.js checks for this object and falls back to its text
  // input when absent, which is what keeps the browser build byte-for-byte unchanged.
  isDesktop: true,

  /**
   * Open a native file picker and return the chosen path, or null if cancelled.
   * A path only -- the renderer fetches the content through /file?path=.
   * @param {string} [defaultPath]
   * @returns {Promise<string|null>}
   */
  openMarkdown: (defaultPath) => ipcRenderer.invoke('desktop:openMarkdown', defaultPath),

  /**
   * Probe the server now. Resolves true if it answered, in which case the main process is
   * already loading the app over this window.
   * @returns {Promise<boolean>}
   */
  retry: () => ipcRenderer.invoke('desktop:retry')
});
