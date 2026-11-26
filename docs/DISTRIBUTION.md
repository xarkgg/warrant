# Distribution — how a judge installs Warrant

The submission asks for "an installation link … for the judges". This is the
state of that, what is already done, and the one step that needs a human in a
browser.

---

## 1. What is already true

| Thing | State |
|---|---|
| Production deploy | **Live.** `forge deploy -e production` → **2.0.0** |
| Installed on a real site | **Live.** `one-atlas-lkwc.atlassian.net`, Jira, production env |
| Public product page | https://xarkgg.github.io/warrant-site/ |
| Public privacy statement | https://xarkgg.github.io/warrant-site/privacy.html |
| Public support link | https://github.com/xarkgg/warrant-site/issues |
| Licensing in the manifest | `enabled: false` — so the app **can** be shared by link |
| Marketplace listing | **None.** Not needed for an install link |

The site and the privacy page exist because the Atlassian developer console will
not hand out an installation link until an app has a support URL and a privacy
policy URL. Both had to be public, and the source repo is private, so those two
pages live in their own public repo: `xarkgg/warrant-site`.

---

## 2. The one step left

An installation link can only be created by the app's owner, in a browser, in
the Atlassian developer console. There is no CLI command and no API for it —
`forge` has no `distribution` verb, and the console's own API is not public. It
is a five-field form.

**Open this URL while signed in as the account that owns the app:**

https://developer.atlassian.com/console/myapps/d06aafb5-91a9-446d-9bcd-39aa170b361e/manage/distribution

1. Under **Distribution controls**, select **Edit**.
2. Select **Sharing** — *not* "Sharing within organization". Judges are outside
   any organization of ours, and organization-sharing refuses them outright even
   with the link.
3. Fill the form in with the values below.
4. Save.
5. Under the Atlassian apps list, tick **Jira** only. Ticking Confluence would
   mean the app can only be installed on sites that run both.
6. Copy the installation link that appears.

### Values to paste

| Field | Value |
|---|---|
| Company / department | `Baseline` |
| Support contact | `https://github.com/xarkgg/warrant-site/issues` |
| Privacy policy | `https://xarkgg.github.io/warrant-site/privacy.html` |
| Does the app store personal data? | **Yes** — Atlassian account IDs and display names appear on warrants and ledger entries, because who granted authority is the point of the product. Nothing else is stored, and nothing leaves Atlassian. |
| Atlassian apps | **Jira** |

Answering "yes" to personal data is not a problem for a hackathon entry; a false
"no" would be, because the app demonstrably records account IDs. The privacy
statement says exactly this.

### Then, with the link in hand

Done 2026-11-22. The link is live on `warrant-site/index.html`:

```
https://developer.atlassian.com/console/install/d06aafb5-91a9-446d-9bcd-39aa170b361e?signature=AYABeLiKNKXf2s1xbY8BPfuZj0oAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBzGRL9PJsw0mPBYoIfaAT0gAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDIMwFS29CL3ra69CcAIBEIA7WIxTbaO3HTmfCDDHRQ%2BXOoIVYMrKTGrmBy6M%2BUcEafz6o6uSwL%2B%2Bm21H8lrAoiBC79grmLK6q1DUn3cAB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgG9fTwXSNNAFyHrjpjwMb3TAAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQM1CAmA%2B9kBqx2xO%2FAAgEQgDud9IrZ84h9OLOa8w9MfarPlD2G1nKYShVyhZwgLHVy2InsCrOm%2BXNE0T49ID72ErukB1j00q%2BC5DB84AAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAV7ll4CQrji8SuNcOwCk2F0AAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAy2gy9Mh88hY3pvz9ECARCAO3TYgC%2Bp7KLvmWms57USj5rcWKM%2FcApZeNLm6DmLBoPXldO3JN1hyc%2FNlpXEXgzpIIGGyx2bbYbmwQl9AgAAAAAMAAAQAAAAAAAAAAAAAAAAAIby0uNiX32HczhOWBsnb2f%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADLdXCRPX4Bfj9qY9oLyeF%2FQym4usmny6kEz%2BZvyhpVRTMorch1s1sdAOSuqVUUeTpdp1hX6%2F3MybBUk%2FQMr9zf3CSM%3D&product=jira
```

- [x] Replaced the placeholder in `warrant-site/index.html` (the element with
      `id="install-link"`) and deleted the `[href="#install"]` rule in
      `style.css`, so the button reads as live rather than disabled.
- [ ] Put the link in the Devpost submission's "installation instructions" field.
      **This is the operator's to do** — it is the one place the link has to be
      typed by hand.
- [x] The video end card carries `xarkgg.github.io/warrant-site` instead of the
      link itself. A 1,400-character URL on a 1920-wide frame is unreadable and
      untypeable; the short address is the thing a judge can act on.

---

## 3. What a judge does with it

1. Opens the link. A Forge installation screen appears listing the app and the
   scopes it is requesting.
2. Picks a Jira Cloud site they administer. **They must be a site or app
   admin** — Atlassian requires it, and there is no way around it. A judge who
   has no site creates a free Jira site first; the app installs the same way.
3. Approves the scopes.
4. In Jira: **Apps → Warrant → Authority** for the console, or open any issue
   and find **Warrant** in the issue panel.

No demo site is provided and none should be: a demo site would need credentials
handed out, and the product's whole claim is that a person on their own site
signs their own authority.

---

## 4. After sharing, check these

Do these once, immediately, because a broken install link discovered on the
judging day is unrecoverable.

- [ ] The installation link opens an installation screen while **signed out** of
      every Atlassian session (a private window), proving it is not scoped to
      our cookies.
- [ ] Installing on a **second site** (any free Jira Cloud site, signed up with
      another address) completes and the issue panel renders.
- [ ] On that fresh install the panel shows its empty state and can create a
      warrant — the app must not depend on data left behind by our own site.
- [ ] `forge logs -e production -s 10m` shows no errors from the install.

That second-site test is the only real proof the app is installable by a stranger.
It has not been done yet.

---

## 5. Re-deploying after the link exists

The link is stable across deploys. To ship code without touching it:

```sh
forge deploy -e production
```

Existing installations pick up the new version through Connected apps; a judge
installing later gets the latest. **If scopes change**, they have to re-consent,
and the install link is the way to trigger that.

Generating a new installation link invalidates the old one and cannot be undone.
Only do that if the link leaks somewhere it should not be.
