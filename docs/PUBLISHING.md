# Publishing E-Mail Manager to the Chrome Web Store

Do these steps once, signed in as **robdatta@gmail.com**. End users never see any of this; they just install the extension and click **Connect**.

---

## 1. Register as a Chrome Web Store developer

1. Go to <https://chrome.google.com/webstore/devconsole> and sign in.
2. Accept the developer agreement and pay the one-time registration fee.
3. Under **Account**, set the publisher display name to "Rob Datta" and the contact e-mail to robdatta@gmail.com. Verify the e-mail address.

## 2. Reserve the extension ID

The Google sign-in redirect address depends on the extension's ID, so get the ID first.

1. Run `./scripts/package.sh` to build `dist/email-manager-1.0.0.zip`.
2. In the developer console, click **New item** and upload the zip. Do **not** submit it yet.
3. Copy the **Item ID**: 32 letters, shown at the top of the item page. The redirect address is:

   ```
   https://<ITEM_ID>.chromiumapp.org/
   ```

To keep the same ID while testing an unpacked copy: on the item's **Package** tab, copy the **public key** and add it to `manifest.json` as `"key": "<public key>"`. Remove that line again before uploading.

## 3. Create the Google OAuth client

1. Open <https://console.cloud.google.com/>, create a project (e.g. "E-Mail Manager") and select it.
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type: **External**.
   - App name **E-Mail Manager**, support e-mail and developer contact **robdatta@gmail.com**, logo `docs/icon512.png` (resize it to 120×120).
   - App home page: `https://github.com/robdatta/E-mail_Manager`.
   - Privacy policy: a public URL for `PRIVACY.md`, e.g. `https://github.com/robdatta/E-mail_Manager/blob/main/PRIVACY.md`, or the GitHub Pages copy.
   - **Scopes**: add `https://www.googleapis.com/auth/gmail.modify`.
4. **Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URI: `https://<ITEM_ID>.chromiumapp.org/` from step 2.
5. Copy the **Client ID** into `lib/config.js`:

   ```js
   export const OAUTH_CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
   ```

## 4. Google OAuth verification (required for public use)

`gmail.modify` is a **restricted** Gmail scope. Until Google verifies the app:

- while the consent screen is in **Testing**, only test users you add (up to 100) can sign in;
- in **Production** but unverified, users see an "unverified app" warning, and the number of users is capped.

To let **any** user install it without warnings:

1. On the consent screen, click **Publish app**, then **Prepare for verification**.
2. Provide:
   - the justification below;
   - a YouTube demo video of the sign-in screen and each feature that uses Gmail data;
   - proof that you own the home page domain (a GitHub Pages site under your account works).
3. Complete the **security assessment** that Google requires for restricted scopes. It is done by a Google-approved assessor, may have a fee, and must be renewed every year.

Justification text you can use:

> E-Mail Manager is a Chrome extension that automatically replies to e-mails that match rules the user defines. It needs gmail.modify to (1) read messages in the folder the user selects so they can be matched against the user's rules, (2) send the user's reply with the user's chosen attachments in the same thread, and (3) apply the labels, archive and mark-as-read actions the user configured. All processing happens locally in the user's browser. No Gmail data is sent to any server other than Google's. A narrower scope cannot both send replies and change labels.

## 5. Fill in the store listing

On the item page:

- **Store listing**: paste the text from `docs/STORE_LISTING.md` and upload the screenshots from `docs/screenshots/` (1280×800). Use category **Productivity** and language **English**.
- **Privacy practices**:
  - Single purpose and permission justifications: from `docs/STORE_LISTING.md`.
  - Data usage: tick **Personally identifiable information** (e-mail address) and **Personal communications** (e-mail).
  - Certify that the data is not sold, not used for unrelated purposes and not used for creditworthiness.
  - Privacy policy URL: same as in step 3.
- **Distribution**: Public, all regions.

## 6. Submit

1. Rebuild the zip after setting the client ID: `./scripts/package.sh`.
2. On the **Package** tab, upload the new zip.
3. Click **Submit for review**. Reviews usually take a few days. Extensions that use Gmail data can take longer.

## Updating later

1. Increase `"version"` in `manifest.json`.
2. Run `./scripts/package.sh` and upload the zip on the **Package** tab.
3. Submit.

Users get the update automatically.
