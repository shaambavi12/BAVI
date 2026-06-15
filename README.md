# BAVI FlowState v13

Works fully offline on any one device. Set up sync (below, ~5 minutes, once)
to share one library + history across phone, TV and laptop, and to send a
flow from your phone straight to the TV.

## 1 · Host the app
Deploy this folder anywhere static (your usual PWA deployment engine,
Cloudflare Pages, GitHub Pages…). Open the URL on each device; install/
add-to-home-screen as usual. On the TV, open the same URL in the TV browser.

## 2 · Deploy the sync Worker (once, from this folder)
1. `npm i -g wrangler` then `wrangler login`
2. `wrangler d1 create flowstate`  → copy the `database_id` into `wrangler.toml`
3. `wrangler d1 execute flowstate --remote --file=schema.sql`
4. `wrangler deploy`

Wrangler prints a URL like `https://flowstate-sync.<you>.workers.dev`.

## 3 · In the app, on EVERY device — Settings → Devices & sync
- **Sync URL** = that Worker URL
- **Shared key** = any word, identical on every device (scopes your data)
- **Device name** = e.g. "Phone" / "Living room TV"
- **This device is:** set to **TV** on the television (don't rely on detection)
- Tap **Test connection** — you should see "Connected ✓"

Then:
- Build/edit a flow on the phone → it appears on the TV within ~20s
  (or instantly via **Sync now**), and you can press play there with the remote.
- Or tap 📺 on any flow in the phone's library → the TV launches it itself.

## 4 · ADB / automation deep links
Any flow can be launched by URL — no app changes needed:

```
https://YOUR-HOST/index.html?flow=Morning%20Reset          ← by exact name
https://YOUR-HOST/index.html?flow=f_1718000000_ab12cd      ← or by id
https://YOUR-HOST/index.html?flow=Morning%20Reset&start=2  ← start at task 3
```

Example ADB (turn on TV, open FlowState, start the flow):
```
adb connect TV_IP:5555
adb shell input keyevent KEYCODE_WAKEUP
adb shell am start -a android.intent.action.VIEW -d "https://YOUR-HOST/index.html?flow=Morning%20Reset"
```
The TV pulls the latest library from sync before launching, so a flow you
saved on your phone seconds earlier will be found.

## Notes
- Rotation: the app now follows each device's own rotation/auto-rotate
  setting (the old manifest forced "any" and overrode it). Re-install /
  refresh the installed PWA once for the manifest change to take.
- AI (optional): Settings → AI (Groq). Two keys — timing + language.
  Default model for both: `llama-3.3-70b-versatile`.
