# Armada launcher

The desktop client for [Armada](https://armada-gray.vercel.app), a persistent
multiplayer world of floating sky isles.

**[Download for Windows](https://armada-gray.vercel.app/download)**

## What this repository is

Two things: the source of the launcher, and the place its installers are
published from.

It is not the game. The launcher is a shell — it opens a window, asks the
machine for the fast graphics adapter, and points that window at the game. The
simulation, the balance numbers and the server live in a private repository,
because the client was always the disposable half.

That split is deliberate rather than secretive. Auto-update and a public
download link both read from GitHub Releases, and release assets on a private
repository need an authenticated token to fetch. Pointing the updater at a
private repo would mean shipping a credential inside the app. So the shell,
which reveals nothing, lives here in the open, and the game does not.

## Why install it rather than open a browser tab

- **It uses the right graphics card.** On a handheld or any laptop with
  switchable graphics, a browser will quietly render on the power saving
  adapter and stay there.
- **It is never throttled.** Browsers slow down tabs you are not looking at,
  which is precisely wrong for a world that keeps turning while you watch it on
  a second monitor.
- **It stays signed in.** Once, on the first launch.
- **It updates itself.** Checked on every start, installed quietly on quit.

The browser version is the same game and always will be. Neither client decides
anything; the server does.

## Working on it

```bash
pnpm install
pnpm dev              # run the launcher against production
pnpm dist:win         # build an installer without publishing
```

Point it somewhere else while developing:

```bash
ARMADA_SITE=http://localhost:3000 \
ARMADA_HEALTH=http://localhost:8080/health \
pnpm dev
```

## Releasing

```bash
git tag v0.1.0 && git push origin v0.1.0
```

CI builds Windows and macOS and opens a **draft** release. Publishing that
draft is the moment the download link and every installed launcher start
seeing the new version.

Installers are unsigned, so Windows SmartScreen warns on first run. That is
what a program Microsoft has never seen looks like, and the download page says
so plainly rather than letting people discover it and assume the worst.
