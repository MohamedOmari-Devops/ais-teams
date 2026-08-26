# AIS Teams — showcase site

The marketing page for the app in this repository. Plain HTML, CSS and
JavaScript: no framework, no build step, no dependencies.

```
website/
├── index.html      every section, top to bottom
├── styles.css      design tokens + all layout
├── script.js       theme toggle, tabs, copy buttons, reveal on scroll
├── build.mjs       optional: inline everything into dist/index.html
└── assets/logo.png the app icon, also used as favicon and social card
```

## Run it

Open `index.html` in a browser, or serve the folder if you want the copy
buttons to work (the Clipboard API needs a secure context, which `file://`
is not):

```bash
python -m http.server 4321 --directory website
# then http://localhost:4321
```

## Deploy it

Upload the folder. It is static — GitHub Pages, Netlify, Cloudflare Pages, S3,
or any web root will serve it as is. There is nothing to compile.

For a host that will not serve relative assets, or anywhere that takes a single
file, inline the whole thing first:

```bash
node website/build.mjs      # -> website/dist/index.html
```

## Design

The palette comes from the logo, sampled rather than guessed:

| Token | Value | Used for |
|---|---|---|
| `--blue` | `#106BFB` | primary actions, links, accents, the CTA band |
| `--blue-700` | `#0B54CC` | hover on primary |
| `--blue-050` | `#EEF4FF` | icon plates, selected rows |
| `--ink` | `#0A0B0D` | headings and body |
| `--muted` | `#5B616E` | secondary copy |
| `--line` | `#E5E8EE` | every 1px border |

Everything is a CSS custom property on `:root`, with the dark set repeated in
three places so the page is correct in each state: `@media
(prefers-color-scheme: dark)` for a visitor who never touched the toggle,
`:root[data-theme="dark"]` for one who did, and `:root` itself for light. The
`<head>` stamps the saved choice before first paint, the same trick the desktop
app uses, so switching themes never flashes.

Type is Inter for text and JetBrains Mono for anything that names a file, a
flag or a value — the same split the app itself uses.

## Editing

- Sections are separated by comment banners in `index.html`; each one is
  self-contained and can be reordered or removed.
- The hero "screenshot" is not an image. It is the `.shot` block: real markup
  styled to look like the app, so it stays sharp at any size and updates when
  the design does.
- Add a nav link by adding an `<a>` to both `.nav__links` and `.nav__drawer`.
- The product tabs are wired by `data-tab` on the button matching `data-panel`
  on the pane. Adding a pair is the whole job.
