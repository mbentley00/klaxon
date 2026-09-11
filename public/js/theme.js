/* Klaxon light/dark theme. A classic script, loaded synchronously in the
   <head> of every page BEFORE the stylesheet, so the right theme is on the
   root element before anything paints — no flash of paper at 1am on Discord.

   The contract (the MODAQ page relies on exactly this — keep it stable):
   - localStorage `bz_theme` is the explicit choice, "dark" or "light". Absent
     (or anything else) means follow the OS (prefers-color-scheme).
   - <html data-theme="dark|light"> always carries the EFFECTIVE theme, and
     <html style="color-scheme"> matches it so native controls follow.
   - It re-stamps when the OS preference flips (only while no explicit choice
     is stored) and when bz_theme changes in another tab, so a toggle anywhere
     reaches every open Klaxon tab.
   - window.klaxonTheme = { get(), pref(), set(pref) }; set("system") removes
     the key. Every stamp dispatches `klaxon-theme` on document with
     detail.theme.

   The toggle button is mounted on pages that have Klaxon's header bar
   (.bar) or the centred card layout (body.landing), or into any element
   marked [data-theme-toggle-slot]. Pages with none of those (the MODAQ
   reader) get the behaviour above but no button of ours. */
(function () {
  'use strict';
  var KEY = 'bz_theme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  // The browser-chrome colour on phones: the page ground of each theme.
  var CHROME = { light: '#f3efe6', dark: '#1b1814' };

  // Storage can be missing or throw (private mode, blocked site data). Once it
  // has failed us, the choice lives in memory for this page instead, so the
  // toggle still works — it just won't outlive the tab.
  var mem = null;
  function norm(v) { return v === 'dark' || v === 'light' ? v : 'system'; }
  function pref() {
    if (mem === null) {
      try { return norm(window.localStorage.getItem(KEY)); } catch (e) { mem = 'system'; }
    }
    return mem;
  }
  function osTheme() { return mq && mq.matches ? 'dark' : 'light'; }
  function get() { var p = pref(); return p === 'system' ? osTheme() : p; }

  function stamp() {
    var theme = get();
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', CHROME[theme]);
    try {
      document.dispatchEvent(new CustomEvent('klaxon-theme', { detail: { theme: theme } }));
    } catch (e) { /* ancient browser: the attribute is what matters */ }
    return theme;
  }

  function set(p) {
    p = norm(p);
    if (mem === null) {
      try {
        if (p === 'system') window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, p);
      } catch (e) { mem = p; }
    } else {
      mem = p;
    }
    stamp();
  }

  window.klaxonTheme = { get: get, pref: pref, set: set };
  stamp();

  if (mq) {
    var onOs = function () { if (pref() === 'system') stamp(); };
    if (mq.addEventListener) mq.addEventListener('change', onOs);
    else if (mq.addListener) mq.addListener(onOs);
  }
  // Another tab changed (or cleared) the choice.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY || e.key === null) stamp();
  });
  // Back/forward cache: a page restored from it missed any storage events.
  window.addEventListener('pageshow', function (e) { if (e.persisted) stamp(); });

  // ---- the toggle -------------------------------------------------------
  var SVG = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
    'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
  // The icon shows where a click takes you, matching the button's name.
  var MOON = '<svg ' + SVG + '><path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/></svg>';
  var SUN = '<svg ' + SVG + '><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22' +
    'M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/></svg>';

  function render(btn) {
    var dark = get() === 'dark';
    var label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.innerHTML = dark ? SUN : MOON;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.setAttribute('data-theme-now', dark ? 'dark' : 'light');
  }

  function mount() {
    if (document.querySelector('.theme-toggle')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    var host = document.querySelector('[data-theme-toggle-slot]');
    if (!host) {
      var bar = document.querySelector('header.bar');
      if (bar) {
        host = bar.querySelector('.bar-right');
        if (!host) {
          host = document.createElement('div');
          host.className = 'bar-right';
          bar.appendChild(host);
        }
      } else if (document.body && document.body.classList.contains('landing')) {
        host = document.body;
        btn.className += ' theme-toggle-corner';
      }
    }
    if (!host) return;
    // (Space stays the room's buzz key even with this focused: room.js drops
    // focus from any button before acting on it.)
    btn.addEventListener('click', function () { set(get() === 'dark' ? 'light' : 'dark'); });
    render(btn);
    host.appendChild(btn);
    document.addEventListener('klaxon-theme', function () { render(btn); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
