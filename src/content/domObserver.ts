type RouteHandler = (path: string) => void;

export function observeRouteChanges(handler: RouteHandler, debounceMs = 250): () => void {
  let timer: number | undefined;
  let lastPath = location.pathname;

  const run = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
      }
      handler(lastPath);
    }, debounceMs);
  };

  const observer = new MutationObserver(run);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', run);

  // Patch pushState/replaceState to detect SPA nav.
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    const r = origPush.apply(this, args as Parameters<typeof origPush>);
    run();
    return r;
  };
  history.replaceState = function (...args) {
    const r = origReplace.apply(this, args as Parameters<typeof origReplace>);
    run();
    return r;
  };

  handler(lastPath);

  return () => {
    observer.disconnect();
    window.removeEventListener('popstate', run);
  };
}
