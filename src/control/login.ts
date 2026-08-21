/**
 * The sign-in page.
 *
 * It lives here rather than in `web/` because the dashboard bundle has no login
 * screen and `web/src/` is not this module's to change. Three tiny same-origin
 * assets — no inline `<script>`, no inline `<style>`, no external host — so the
 * strict CSP in `./index.ts` needs no `unsafe-inline` exception for scripts and
 * no `font-src` exception for anybody's CDN.
 *
 * The page exchanges the daemon's API bearer token for a session cookie via
 * `POST /api/session`, then sends the operator to `/`.
 */

export const LOGIN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta name="robots" content="noindex,nofollow" />
    <title>ARI OS Control — sign in</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/login.css" />
  </head>
  <body>
    <main>
      <p class="eyebrow">ARI OS</p>
      <h1>Control</h1>
      <p class="lede">
        This console can engage the kill switch and decide approvals that move
        real value. Present the daemon's API token to open a session.
      </p>
      <form id="f" autocomplete="off">
        <label for="token">API bearer token</label>
        <input id="token" name="token" type="password" required
               autocomplete="current-password" spellcheck="false" />
        <button type="submit" id="go">Open session</button>
      </form>
      <p class="err" id="err" role="alert" hidden></p>
      <p class="foot">
        The token is the value behind <code>API_BEARER_TOKEN</code>. It is
        exchanged once for an HttpOnly, SameSite=Strict session cookie and is
        never stored in the browser.
      </p>
    </main>
    <script src="/login.js"></script>
  </body>
</html>
`;

export const LOGIN_CSS = `:root {
  --obsidian: #050706;
  --bone: #eef1e9;
  --acid: #b6ff36;
  --hazard: #ff5c37;
  --line: rgba(238, 241, 233, 0.14);
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  background: var(--obsidian);
  color: var(--bone);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: -0.02em;
}
main { width: 100%; max-width: 420px; }
.eyebrow {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--acid);
}
h1 { margin: 6px 0 18px; font-size: 40px; font-weight: 500; letter-spacing: -0.05em; }
.lede { margin: 0 0 26px; font-size: 14px; line-height: 1.6; opacity: 0.66; }
form { display: grid; gap: 10px; }
label {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.6;
}
input {
  width: 100%;
  padding: 13px 14px;
  border: 1px solid var(--line);
  border-radius: 2px;
  background: rgba(238, 241, 233, 0.04);
  color: var(--bone);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 14px;
}
input:focus { outline: 1px solid var(--acid); border-color: var(--acid); }
button {
  margin-top: 6px;
  padding: 13px 14px;
  border: 0;
  border-radius: 2px;
  background: var(--acid);
  color: var(--obsidian);
  font: inherit;
  font-weight: 600;
  letter-spacing: -0.02em;
  cursor: pointer;
}
button[disabled] { opacity: 0.5; cursor: progress; }
.err {
  margin: 16px 0 0;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--hazard);
}
.foot {
  margin: 28px 0 0;
  padding-top: 18px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.5;
}
code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; }
`;

export const LOGIN_JS = `"use strict";
(function () {
  var form = document.getElementById("f");
  var field = document.getElementById("token");
  var button = document.getElementById("go");
  var error = document.getElementById("err");
  function fail(message) {
    error.textContent = message;
    error.hidden = false;
    button.disabled = false;
  }
  // A daemon with no credential can never mint a session, so say that here
  // rather than letting the operator type a token into a form that must refuse.
  fetch("/api/session", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (state) {
      if (state.authenticated) {
        window.location.replace("/");
        return;
      }
      if (!state.configured) {
        button.disabled = true;
        field.disabled = true;
        fail(
          "AUTH_NOT_CONFIGURED \\u2014 this daemon has no API credential, so no session can be opened. Set API_BEARER_TOKEN (or API_BEARER_TOKEN_SHA256) and restart."
        );
        button.disabled = true;
      }
    })
    .catch(function () {});
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    error.hidden = true;
    button.disabled = true;
    fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: field.value })
    })
      .then(function (response) {
        if (response.ok) {
          window.location.replace("/");
          return null;
        }
        return response.json().catch(function () {
          return null;
        }).then(function (body) {
          var detail = body && body.error ? body.error : null;
          fail(
            detail
              ? detail.code + " — " + detail.message
              : "sign-in refused (" + response.status + ")"
          );
        });
      })
      .catch(function () {
        fail("the daemon is unreachable");
      });
  });
})();
`;
