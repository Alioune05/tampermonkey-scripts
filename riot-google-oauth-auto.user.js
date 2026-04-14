// ==UserScript==
// @name         Riot Games Google OAuth Auto
// @namespace    https://github.com/Alioune05/tampermonkey-scripts
// @version      1.0.0
// @description  Automatically click through the Riot Games Google OAuth page and close on success
// @icon         https://www.google.com/favicon.ico
// @match        *://accounts.google.com/v3/signin/accountchooser*
// @match        *://accounts.google.com/AccountChooser*
// @match        *://accounts.google.com/signin/oauth/consent*
// @match        *://authenticate.riotgames.com/*
// @grant        GM_closeTab
// @grant        window.close
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Alioune05/tampermonkey-scripts/master/riot-google-oauth-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/Alioune05/tampermonkey-scripts/master/riot-google-oauth-auto.user.js
// @homepageURL  https://github.com/Alioune05/tampermonkey-scripts
// @supportURL   https://github.com/Alioune05/tampermonkey-scripts/issues
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Guard: only act on Riot Games OAuth flows.
  // ---------------------------------------------------------------------------
  function isRiotFlow() {
    const full = location.href;
    if (full.includes('riotgames')) return true;
    try {
      const params = new URLSearchParams(location.search);
      const check = [
        params.get('redirect_uri'),
        params.get('app_domain'),
        params.get('continue'),
      ];
      return check.some(v => v && v.includes('riotgames'));
    } catch (_) { return false; }
  }

  // ---------------------------------------------------------------------------
  // Success page: authenticate.riotgames.com shows "Connexion au client Riot"
  // once the OAuth handshake completes. Close as soon as the panel renders.
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

  if (!isRiotFlow()) return;

  // ---------------------------------------------------------------------------
  // Account chooser: click the first visible account row.
  // ---------------------------------------------------------------------------
  function tryClickAccount() {
    const btn = document.querySelector('[data-button-type="multipleChoiceIdentifier"]');
    if (btn && btn.offsetParent !== null) {
      btn.click();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Consent page (first authorisation only): click the primary action button.
  // ---------------------------------------------------------------------------
  function tryClickConsent() {
    const candidates = [
      document.querySelector('[data-primary-action-button]'),
      document.querySelector('button[type="submit"]'),
      ...[...document.querySelectorAll('button')].filter(b => {
        const t = b.textContent.trim().toLowerCase();
        return (t.includes('continue') || t.includes('continuer') ||
                t.includes('allow') || t.includes('autoriser')) &&
               b.offsetParent !== null;
      }),
    ].filter(Boolean);

    for (const el of candidates) {
      if (el.offsetParent !== null) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function tryClick() {
    return tryClickAccount() || tryClickConsent();
  }

  if (!tryClick()) {
    const observer = new MutationObserver(() => {
      if (tryClick()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10_000);
  }

})();
