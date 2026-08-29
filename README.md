# Song Bird Publishing — website

A static site built with [Eleventy](https://www.11ty.dev/), edited through
[Sveltia CMS](https://sveltiacms.app/), hosted on Cloudflare.

Content lives in this repository as plain files. The CMS is a login screen at
`/admin` that edits those files for you and saves the change back here, which
makes Cloudflare rebuild the site. No database, nothing to keep patched.

---

## Setup

You only do this once. Steps 1–3 have to be done by you, because they involve
accounts in your name.

### 1. Put this on GitHub

Create a free account at github.com, then create a repository named
`songbird-publishing`. Keep it **private** — the site is public, the source
doesn't need to be. Upload the contents of this folder (not the folder itself).

Do not upload `node_modules` or `_site` if you have them locally. They're
listed in `.gitignore` and rebuild automatically.

### 2. Point the CMS at your repository

Open `src/admin/config.yml` and change the second line:

```yaml
repo: YOUR-GITHUB-USERNAME/songbird-publishing
```

Replace `YOUR-GITHUB-USERNAME` with your actual GitHub username. If you named
the repository something else, change that half too.

### 3. Connect Cloudflare

In the Cloudflare dashboard, create a new project from a Git repository and
pick this one. Use these build settings:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `_site` |

Cloudflare rebuilds and redeploys every time content is saved — about a minute
from clicking Save in the CMS to the change being live.

Then add `songbirdpublishingllc.com` as a custom domain in the project
settings. Cloudflare handles the DNS and the certificate.

### 4. Log in to the CMS

Go to `songbirdpublishingllc.com/admin` and sign in with GitHub. Sveltia also
accepts a fine-grained personal access token if you'd rather not set up an
OAuth app — generate one in GitHub under Settings → Developer settings, scoped
to just this repository with read and write access to contents.

---

## Editing

Everything at `/admin`:

- **Authors** — add, edit, reorder, delete. Photo optional; without one the
  card shows the author's initial. "Order on the page" controls left-to-right.
- **Notes** — the blog. Each note gets its own page at `/notes/its-title/`.
  The three most recent show on the homepage.
- **Page content** — every other word on the site. Headings, the About text,
  the six service cards, submission guidelines, contact details.

Two things worth knowing:

**Submissions can be switched off.** Under Page content → Submissions section
there's an "Open for submissions" toggle. Turn it off and the guidelines are
replaced by the closed message. Turn it back on when you're reading again.

**The contact form needs an endpoint to send real email.** Out of the box it
opens the visitor's mail app, which loses a fair number of people. Sign up for
Formspree or Tally, and paste the form address they give you into Page content
→ Contact section → Form endpoint. The form then posts to them and they email
you.

Images uploaded through the CMS aren't resized, so shrink large photos before
uploading — squoosh.app does it in the browser.

---

## Running it locally (optional)

```
npm install
npm run dev
```

Then open the address it prints. Changes appear as you save.

## What's where

```
src/
  index.njk           the homepage layout
  _data/site.json     all page text (edited via CMS)
  _includes/          shared page shell and note-page layout
  authors/            one file per author (edited via CMS)
  posts/              one file per note (edited via CMS)
  assets/             CSS, logo files, uploaded images
  admin/              the CMS itself
```
