(() => {
  let ws;
  let reqCounter = 0;
  const pending = new Map();
  const dataHandlers = new Map();
  const exitHandlers = new Map();
  const statusHandlers = [];
  const toolHandlers = [];
  const tabMutationHandlers = [];
  let messageQueue = [];

  function connect() {
    ws = new WebSocket(`ws://${location.host}`);

    ws.addEventListener('open', () => {
      for (const msg of messageQueue) ws.send(msg);
      messageQueue = [];
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'state:loaded': {
          const resolve = pending.get(msg.reqId);
          if (resolve) { pending.delete(msg.reqId); resolve(msg.state); }
          break;
        }
        case 'pty:cwd:result': {
          const resolve = pending.get(msg.reqId);
          if (resolve) { pending.delete(msg.reqId); resolve(msg.cwd); }
          break;
        }
        case 'pty:data':
        case 'pty:replay': {
          const cbs = dataHandlers.get(msg.tabId);
          if (cbs) cbs.forEach((cb) => cb(msg.data));
          break;
        }
        case 'pty:exit': {
          const cbs = exitHandlers.get(msg.tabId);
          if (cbs) cbs.forEach((cb) => cb());
          break;
        }
        case 'tab:status': {
          statusHandlers.forEach((cb) => cb({ tabId: msg.tabId, status: msg.status }));
          break;
        }
        case 'pty:reponame:result': {
          const resolve = pending.get(msg.reqId);
          if (resolve) { pending.delete(msg.reqId); resolve(msg.name); }
          break;
        }
        case 'tab:tool': {
          toolHandlers.forEach((cb) => cb({ tabId: msg.tabId, tool: msg.tool }));
          break;
        }
        case 'memory:search:result': {
          const resolve = pending.get(msg.reqId);
          if (resolve) { pending.delete(msg.reqId); resolve(msg.results); }
          break;
        }
        case 'memory:getSession:result':
        case 'memory:getTurn:result': {
          const resolve = pending.get(msg.reqId);
          if (resolve) { pending.delete(msg.reqId); resolve(msg.data); }
          break;
        }
        case 'memory:projects:result': {
          const resolve = pending.get(msg.reqId);
          if (resolve) { pending.delete(msg.reqId); resolve(msg.projects); }
          break;
        }
        // A tab was created, renamed/moved, or closed -- possibly in the other front-end.
        // Delivered to the originating window too; the renderer applies them all through
        // one path, and applyTabMutation() makes re-applying its own change a no-op.
        case 'tab:created':
        case 'tab:updated':
        case 'tab:closed': {
          tabMutationHandlers.forEach((cb) => cb(msg));
          break;
        }
      }
    });

    ws.addEventListener('close', () => {
      setTimeout(connect, 2000);
    });
  }

  function send(obj) {
    const json = JSON.stringify(obj);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    } else {
      messageQueue.push(json);
    }
  }

  connect();

  window.ganglionAPI = {
    loadState() {
      const reqId = ++reqCounter;
      return new Promise((resolve) => {
        pending.set(reqId, resolve);
        send({ type: 'state:load', reqId });
      });
    },
    // Per-tab mutations rather than a whole-file save. The server applies each one to the
    // shared state and rebroadcasts it, so the two front-ends converge instead of taking
    // turns overwriting each other. View state (dividers, panel mode, which tab is active)
    // never goes over the wire at all -- see lib/tab-state.js.
    tabCreated(tab) {
      send({ type: 'tab:created', tab });
    },
    tabUpdated(tabId, patch) {
      send({ type: 'tab:updated', tabId, patch });
    },
    tabClosed(tabId) {
      send({ type: 'tab:closed', tabId });
    },
    onTabMutation(cb) {
      tabMutationHandlers.push(cb);
    },
    ptySpawn(tabId, cwd) {
      send({ type: 'pty:spawn', tabId, cwd });
    },
    ptyWrite(tabId, data) {
      send({ type: 'pty:write', tabId, data });
    },
    ptyResize(tabId, cols, rows) {
      send({ type: 'pty:resize', tabId, cols, rows });
    },
    ptyKill(tabId) {
      send({ type: 'pty:kill', tabId });
    },
    ptyCwd(tabId) {
      const reqId = ++reqCounter;
      return new Promise((resolve) => {
        pending.set(reqId, resolve);
        send({ type: 'pty:cwd', tabId, reqId });
      });
    },
    onPtyData(tabId, cb) {
      if (!dataHandlers.has(tabId)) dataHandlers.set(tabId, new Set());
      dataHandlers.get(tabId).add(cb);
      return () => {
        const set = dataHandlers.get(tabId);
        if (set) { set.delete(cb); if (set.size === 0) dataHandlers.delete(tabId); }
      };
    },
    onPtyExit(tabId, cb) {
      if (!exitHandlers.has(tabId)) exitHandlers.set(tabId, new Set());
      exitHandlers.get(tabId).add(cb);
      return () => {
        const set = exitHandlers.get(tabId);
        if (set) { set.delete(cb); if (set.size === 0) exitHandlers.delete(tabId); }
      };
    },
    onTabStatus(cb) {
      statusHandlers.push(cb);
    },
    onTabTool(cb) {
      toolHandlers.push(cb);
    },
    getRepoName(tabId, cwd) {
      const reqId = ++reqCounter;
      return new Promise((resolve) => {
        pending.set(reqId, resolve);
        send({ type: 'pty:reponame', tabId, cwd, reqId });
      });
    },
    memorySearch(params) {
      const reqId = ++reqCounter;
      return new Promise((resolve) => {
        pending.set(reqId, resolve);
        send({ type: 'memory:search', params, reqId });
      });
    },
    memoryGetSession(sessionId) {
      const reqId = ++reqCounter;
      return new Promise((resolve) => {
        pending.set(reqId, resolve);
        send({ type: 'memory:getSession', sessionId, reqId });
      });
    },
    memoryGetTurn(uuid, context) {
      const reqId = ++reqCounter;
      return new Promise((resolve) => {
        pending.set(reqId, resolve);
        send({ type: 'memory:getTurn', uuid, context, reqId });
      });
    },
    memoryProjects() {
      const reqId = ++reqCounter;
      return new Promise((resolve) => {
        pending.set(reqId, resolve);
        send({ type: 'memory:projects', reqId });
      });
    }
  };
})();
