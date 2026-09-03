// Makes Express 4 handle rejected promises from async route handlers.
//
// Express 4 predates async handlers. It calls the handler and ignores the
// promise it returns, so a rejection becomes an unhandled rejection and the
// request simply never gets a response - the client waits until it times out.
// Before the move to Postgres almost nothing was async, so this barely showed;
// now every handler is, and any database error would hang the caller instead of
// returning a 500.
//
// That failure mode is worse than the error itself: a hung phone heartbeat
// looks to the employee like the app working, while nothing is being recorded.
//
// Express 5 does this natively. Wrapping is the smaller change mid-migration,
// and it is explicit rather than a monkey-patch of Express internals.

/** Wrap one handler so a rejection (or a synchronous throw) reaches next(). */
function wrapHandler(fn) {
  if (typeof fn !== 'function' || fn.__asyncWrapped) return fn;

  // Error-handling middleware is identified by arity, so the wrapper has to
  // preserve it exactly - a 4-argument handler wrapped in a 3-argument function
  // silently stops being an error handler.
  const wrapped = fn.length === 4
    ? function (err, req, res, next) {
      try {
        const out = fn.call(this, err, req, res, next);
        if (out && typeof out.catch === 'function') out.catch(next);
        return out;
      } catch (e) { return next(e); }
    }
    : function (req, res, next) {
      try {
        const out = fn.call(this, req, res, next);
        if (out && typeof out.catch === 'function') out.catch(next);
        return out;
      } catch (e) { return next(e); }
    };

  wrapped.__asyncWrapped = true;
  return wrapped;
}

/**
 * Walk a router's layers and wrap every handler, including those of nested
 * routers mounted with router.use().
 */
function wrapRouter(router, seen = new Set()) {
  const stack = router && (router.stack || (router.handle && router.handle.stack));
  if (!stack || seen.has(stack)) return router;
  seen.add(stack);

  for (const layer of stack) {
    if (layer.route) {
      for (const routeLayer of layer.route.stack) {
        routeLayer.handle = wrapHandler(routeLayer.handle);
      }
      continue;
    }

    // A mounted sub-router: recurse rather than wrapping the router itself.
    if (layer.handle && layer.handle.stack) {
      wrapRouter(layer.handle, seen);
      continue;
    }

    layer.handle = wrapHandler(layer.handle);
  }

  return router;
}

module.exports = { wrapRouter, wrapHandler };
