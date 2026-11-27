/*
 * Vendored from @plannotator/ui 0.66.0,
 * components/html-viewer/sandboxShim.ts (SANDBOX_SHIM_SCRIPT).
 * Licensed under the Apache License, Version 2.0:
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * View mode frames the artifact in its own `allow-scripts` sandbox, an opaque
 * origin where `history.pushState`/`replaceState` and `localStorage`/
 * `sessionStorage` throw. This shim, run first in the document, keeps a page
 * that touches them from stopping halfway and staying blank. It stores
 * nothing between loads and widens no sandbox permission.
 */
export const SANDBOX_SHIM_SCRIPT = `(function() {
  var h = window.history;
  if (h && !(h.replaceState && h.replaceState.plannotatorSandboxShim)) {
    ['pushState', 'replaceState'].forEach(function(name) {
      var original = h[name];
      if (typeof original !== 'function') return;
      var shim = function(state, unused, url) {
        if (url === undefined || url === null) return original.apply(this, arguments);
        var raw = String(url);
        var own = location.href.split('#')[0];
        if (raw === '' || raw.charAt(0) === '#') return original.call(this, state, unused, own + raw);
        if (raw.charAt(0) === '?') {
          try {
            return original.call(this, state, unused, own.split('?')[0] + raw);
          } catch (error) {
            if (!error || error.name !== 'SecurityError') throw error;
            var at = raw.indexOf('#');
            return original.call(this, state, unused, own + (at < 0 ? '' : raw.slice(at)));
          }
        }
        try {
          return original.call(this, state, unused, url);
        } catch (error) {
          if (!error || error.name !== 'SecurityError') throw error;
          var hash = '';
          try { hash = new URL(raw, document.baseURI).hash; } catch (ignored) {}
          return original.call(this, state, unused, own + hash);
        }
      };
      shim.plannotatorSandboxShim = true;
      h[name] = shim;
    });
  }

  function memoryStorage() {
    var items = new Map();
    var api = {
      getItem: function(key) { key = String(key); return items.has(key) ? items.get(key) : null; },
      setItem: function(key, value) { items.set(String(key), String(value)); },
      removeItem: function(key) { items.delete(String(key)); },
      clear: function() { items.clear(); },
      key: function(index) {
        var keys = Array.from(items.keys());
        index = Math.floor(Number(index)) || 0;
        return index >= 0 && index < keys.length ? keys[index] : null;
      }
    };
    var isApi = function(p) { return Object.prototype.hasOwnProperty.call(api, p); };
    var target = typeof Storage === 'function' ? Object.create(Storage.prototype) : {};
    return new Proxy(target, {
      get: function(t, p) {
        if (p === 'length') return items.size;
        if (typeof p === 'string' && isApi(p)) return api[p];
        if (typeof p === 'string' && items.has(p)) return items.get(p);
        return Reflect.get(t, p);
      },
      set: function(t, p, value) {
        if (typeof p !== 'string') return Reflect.set(t, p, value);
        if (!isApi(p) && p !== 'length') items.set(p, String(value));
        return true;
      },
      deleteProperty: function(t, p) {
        if (typeof p === 'string') items.delete(p);
        return true;
      },
      has: function(t, p) { return (typeof p === 'string' && items.has(p)) || p in t; },
      ownKeys: function() { return Array.from(items.keys()); },
      getOwnPropertyDescriptor: function(t, p) {
        if (typeof p === 'string' && items.has(p)) {
          return { value: items.get(p), writable: true, enumerable: true, configurable: true };
        }
        return undefined;
      }
    });
  }
  ['localStorage', 'sessionStorage'].forEach(function(name) {
    try { if (window[name]) return; } catch (denied) {}
    try {
      Object.defineProperty(window, name, { value: memoryStorage(), configurable: true, enumerable: true });
    } catch (ignored) {}
  });
})();`;
