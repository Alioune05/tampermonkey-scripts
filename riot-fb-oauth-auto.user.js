// ==UserScript==
// @name         Riot Games Facebook OAuth Auto
// @namespace    https://github.com/Alioune05/tampermonkey-scripts
// @version      1.0.0
// @description  Automatically click through the Riot Games Facebook OAuth page and close on success
// @match        *://www.facebook.com/dialog/oauth*
// @match        *://www.facebook.com/privacy/consent*
// @match        *://www.facebook.com/login*
// @match        *://authenticate.riotgames.com/*
// @grant        GM_closeTab
// @grant        window.close
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Alioune05/tampermonkey-scripts/master/riot-fb-oauth-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/Alioune05/tampermonkey-scripts/master/riot-fb-oauth-auto.user.js
// @homepageURL  https://github.com/Alioune05/tampermonkey-scripts
// @supportURL   https://github.com/Alioune05/tampermonkey-scripts/issues
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Success page: authenticate.riotgames.com shows a "Connexion au client Riot"
  // panel once the OAuth handshake is complete. Close the tab as soon as that
  // panel is in the DOM (the page is React-rendered so we need an observer).
  // ---------------------------------------------------------------------------
  if (location.hostname === 'authenticate.riotgames.com') {
    function closeTab() {
      if (typeof GM_closeTab !== 'undefined') {
        GM_closeTab();
      }
      window.close();
    }

    function tryClose() {
      const title = document.querySelector('[data-testid="panel-title"]');
      if (title) { closeTab(); return true; }
      return false;
    }

    if (!tryClose()) {
      const observer = new MutationObserver(() => {
        if (tryClose()) observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const interval = setInterval(() => {
        if (tryClose()) { observer.disconnect(); clearInterval(interval); }
      }, 300);
      setTimeout(() => { observer.disconnect(); clearInterval(interval); }, 15_000);
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Guard: only act on Riot-related pages.
  // ---------------------------------------------------------------------------
  function isRiotFlow() {
    return location.href.includes('riotgames') ||
           decodeURIComponent(location.search).includes('riotgames');
  }

  if (!isRiotFlow()) return;

  // ---------------------------------------------------------------------------
  // GDPR/privacy consent page (facebook.com/privacy/consent*):
  // Facebook shows this before the OAuth dialog. Click the continue/accept
  // button to proceed. Matched by exact text (localized).
  // ---------------------------------------------------------------------------
  const CONSENT_EXACT = new Set([
    'continuer',       // fr
    'continue',        // en
    'confirmer',       // fr
    'confirm',         // en
    'accepter',        // fr
    'accept',          // en
    'weiter',          // de
    'continuar',       // es/pt
    'continua',        // it
  ]);

  function findConsentButton() {
    if (!location.pathname.startsWith('/privacy/consent')) return null;
    for (const el of document.querySelectorAll('[role="button"], button')) {
      const text = el.textContent.trim().toLowerCase();
      if (CONSENT_EXACT.has(text) && el.offsetParent !== null &&
          el.getAttribute('aria-disabled') !== 'true') {
        return el;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // OAuth dialog / consent page: "Continue as <Name>" button.
  //
  // Facebook renders this with a stable aria-label. Use it first, then fall
  // back to text-content scanning.
  // ---------------------------------------------------------------------------
  const CONTINUE_PREFIXES = [
    'continuer en tant que',  // fr
    'continue as',            // en
    'weiter als',             // de
    'continuar como',         // es / pt
    'continua come',          // it
  ];

  function findContinueButton() {
    // 1. aria-label attribute
    for (const el of document.querySelectorAll('[role="button"],[role="link"],button')) {
      const label = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      if (CONTINUE_PREFIXES.some(p => label.startsWith(p))) return el;
    }
    // 2. span text-content fallback
    for (const span of document.querySelectorAll('span')) {
      const text = span.textContent.trim().toLowerCase();
      if (CONTINUE_PREFIXES.some(p => text.startsWith(p))) {
        let node = span.parentElement;
        while (node && node !== document.body) {
          if (node.tagName === 'BUTTON' ||
              node.getAttribute('role') === 'button' ||
              node.tagName === 'A') return node;
          node = node.parentElement;
        }
        return span;
      }
    }
    return null;
  }

  function tryClick() {
    const btn = findConsentButton() || findContinueButton();
    if (btn && btn.offsetParent !== null && btn.getAttribute('aria-disabled') !== 'true') {
      btn.click();
      return true;
    }
    return false;
  }

  if (!tryClick()) {
    const observer = new MutationObserver(() => {
      if (tryClick()) { observer.disconnect(); clearInterval(interval); }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-disabled'] });

    const interval = setInterval(() => {
      if (tryClick()) { observer.disconnect(); clearInterval(interval); }
    }, 200);

    setTimeout(() => { observer.disconnect(); clearInterval(interval); }, 10_000);
  }

})();
