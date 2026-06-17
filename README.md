# Phonefriends Station

Phonefriends is a tiny social network disguised as playback controls. Each friend posts one current photo. The station turns those photos into "tracks," and the browser's media controls become the way to move between people.

The first MVP is intentionally simple:

- no accounts
- no friend graph
- one shared station per deployed URL
- one current post per device identity
- camera or file upload capture
- Media Session metadata for lock-screen artwork and next/previous controls

## Run locally

```bash
npm start
```

Open [http://localhost:8080](http://localhost:8080).

Camera access works on `localhost`. On a phone, the site must be served over HTTPS.

## Deploy

For the exact `phonefriends.app` launch checklist, see [DEPLOY.md](./DEPLOY.md).

### Render

1. Push this folder to GitHub.
2. Create a Render Blueprint or Web Service from the repo.
3. Use `npm install` as the build command and `npm start` as the start command.
4. Use a Starter or higher service if you want the included persistent disk.
5. Attach a persistent disk mounted at `/opt/render/project/src/server/data`.
6. Add your custom domain in Render after the first deploy.

This repo includes `render.yaml` with those settings.

### VPS

```bash
npm install
PORT=8080 npm start
```

Put Caddy or nginx in front of the app for HTTPS. Caddy is the easiest path for automatic certificates.

## Data

Posts are stored in `server/data/posts.json`; images are stored in `server/data/uploads/`. On a hosted service, mount that folder on persistent storage so posts survive redeploys.

## Important MVP Limits

This is meant for a private group URL, not a public launch. There is no moderation, rate limiting, abuse reporting, or authentication yet.
