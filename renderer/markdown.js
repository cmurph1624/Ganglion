// Markdown → safe HTML. Everything Ganglion renders as markdown (files, transcript turns,
// session notes) can contain text that came from the web, and script running on this page
// can open the WebSocket and type into a shell. So every render goes through DOMPurify.
// If DOMPurify failed to load, show the source as plain text rather than unsanitized HTML.
(function () {
  function escapeText(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return `<pre>${div.innerHTML}</pre>`;
  }

  window.renderMarkdown = function renderMarkdown(text) {
    const src = String(text == null ? '' : text);
    if (!window.DOMPurify || !window.marked) return escapeText(src);
    return window.DOMPurify.sanitize(window.marked.parse(src));
  };
})();
