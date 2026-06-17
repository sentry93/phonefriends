# Deploy Phonefriends

This is the exact path for getting `phonefriends.app` onto a real HTTPS URL that works on iPhone.

## 1. Push the app to GitHub

Create a GitHub repo, then push this folder.

```bash
git add .
git commit -m "Build Phonefriends station"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/phonefriends.git
git push -u origin main
```

## 2. Create the Render service

1. Go to Render.
2. Create a new Blueprint or Web Service from the GitHub repo.
3. If using the Blueprint, Render reads `render.yaml`.
4. If creating manually:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/api/health`
   - Plan: Starter or higher
   - Disk mount path: `/opt/render/project/src/server/data`
   - Disk size: 1 GB
5. Wait for deploy to finish.
6. Open the temporary HTTPS URL Render gives you, something like:

```text
https://phonefriends-station.onrender.com
```

Use that URL for the first iPhone test before DNS is finished.

## 3. Add the custom domain in Render

In the Render service:

1. Open Settings.
2. Find Custom Domains.
3. Add:

```text
phonefriends.app
```

Render should also add/handle `www.phonefriends.app` as a redirect.

Keep the Render page open because it shows the exact `onrender.com` host for your service.

## 4. Change DNS in Hover

Your screenshot currently shows these records:

```text
A   *   216.40.34.41
A   @   216.40.34.41
MX  @   10 mx.hover.com.cust.hostedemail.com
```

Change them to:

```text
A      @      216.24.57.1
CNAME  www    YOUR-RENDER-SERVICE.onrender.com
MX     @      10 mx.hover.com.cust.hostedemail.com
```

Important:

- Keep the MX record if you use Hover email.
- Delete the `*` wildcard A record unless you intentionally want wildcard subdomains.
- Remove any `AAAA` records if Hover shows them.
- Use the exact Render subdomain from your service, not the placeholder above.

## 5. Verify in Render

Back in Render:

1. Click Verify next to `phonefriends.app`.
2. If it fails, wait a few minutes and try again.
3. Once verified, Render issues HTTPS automatically.

Then test:

```text
https://phonefriends.app
https://www.phonefriends.app
```

## 6. iPhone test script

Use Safari on iPhone.

1. Open the Render URL first, then later `https://phonefriends.app`.
2. Enter a username and tap Next.
3. Allow camera access.
4. Take a photo or choose one.
5. Add a caption and post.
6. On a second phone or another Safari profile, open the same URL and post another photo.
7. Go to Station.
8. Tap Play.
9. Lock the phone.
10. Use lock-screen next/previous controls to move between friends.

Expected behavior:

- Camera requires HTTPS.
- First Play requires a tap.
- The lock-screen card can disappear if another app takes over audio.
- If the station has no posts, Play stays disabled.
