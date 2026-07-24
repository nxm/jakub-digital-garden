# jakub.app

My digital garden – a folder of Markdown notes rendered into a small static site
by a zero-config generator built on [Bun](https://bun.sh).

## Layout

```
docs/                 # content – your Obsidian vault (Markdown)
  system/menu.json    # site title, nav, home page
  Home.md             # home page (menu.home = "Home")
  Me/  Concepts/  Projects/  Tools/  Lab/
engine/               # the generator (build/dev/template/markdown)
  styles/  scripts/  templates/  public/
dist/                 # build output (gitignored)
```

## Develop

Bun is provided by the flake's dev shell — no global install needed:

```bash
nix develop            # drops you into a shell with bun on PATH
bun install
bun run dev            # build + watch + serve on http://localhost:3000
```

```bash
bun run build          # one-shot build → dist/
bun run preview        # serve the built dist/
```

With [direnv](https://direnv.net) + `nix-direnv`, the shell loads automatically
on `cd` (a `.envrc` with `use flake` is included — run `direnv allow` once).

Without entering the shell, one-off commands work too:

```bash
nix develop -c bun run dev
```

> The npm scripts spawn a child `bun` process, so `bun` must be on `PATH`.
> Inside `nix develop` (or with bun in your nix-darwin `environment.systemPackages`)
> that's the case. A bare `nix run nixpkgs#bun -- engine/dev.ts` will **not** work —
> use `nix shell nixpkgs#bun -c bun engine/dev.ts` if you skip the flake.

## Authoring notes

- Any `.md` file under `docs/` becomes a page. Folder → section.
- A folder with child notes auto-generates a listing page.
- Frontmatter: `title`, `description`, `date`, `tags`, `order`,
  `draft: true` / `publish: false` to hide, `unlisted: true` to hide from listings.
- Obsidian-style `[[wikilinks]]` and `![[image.png]]` embeds resolve automatically.
- Add a nav item by editing `docs/system/menu.json`.

## Author in Obsidian

The `docs/` folder **is** an Obsidian vault – open it directly:

1. Obsidian → *Open folder as vault* → select `docs/`.
2. It's pre-configured (`docs/.obsidian/app.json`): wikilinks on, shortest-path
   links, attachments saved to `docs/media/`.
3. Write notes; `[[wikilinks]]` and `![[image.png]]` embeds map straight to the
   built site. Run `bun run dev` alongside to see changes live.

### URLs

- A note `Concepts/note.md` builds to `/Concepts/note.html`.
- A folder note `Concepts/index.md` builds to `/Concepts.html` (the section
  listing) – **not** `/Concepts/index.html`.
- Pretty directory URLs still work: `/Concepts/` and `/Concepts/index.html`
  redirect to the canonical page, so hand-typed paths never 404.

## Newsletter

The `<NewsletterForm />` shortcode is inert until you set an endpoint. Copy
`.env.example` to `.env` and set `PUBLIC_NEWSLETTER_ENDPOINT` to your own
subscribe API, or remove the form and the `/newsletter` nav item.

## Deploy

`.github/workflows/pages.yml` builds with Bun and deploys `dist/` to GitHub
Pages on every push to `main`. `engine/public/CNAME` pins the custom domain
`jakub.app` – point the domain's DNS at GitHub Pages to go live.
