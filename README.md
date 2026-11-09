# TweetWiper

Deletes every post, reply and repost on your own X account. It is a small Chrome/Edge extension that works inside the X tab you are already signed into, so signing in with Google is fine. It never sees your password, sends nothing anywhere except to x.com, and is free (MIT license).

**Get it:** [download TweetWiper-extension.zip](https://github.com/spacegeesus/TweetWiper/releases/latest/download/TweetWiper-extension.zip) and unzip it, or clone this repo. Then follow the steps below. The archive step is optional; the Scan button alone gets everything, it just takes a few rounds.

## Your move

1. 🔴 **Ask X for your archive first** (optional but strongly recommended). On x.com: More → Settings and privacy → Your account → Download an archive of your data. X emails you a zip within about a day. This is your only backup, and it also gives the tool a complete list of your posts.
2. 🔴 **Load the extension.** In Chrome go to `chrome://extensions` (Edge: `edge://extensions`). Turn on **Developer mode** (top right). Click **Load unpacked** and pick the folder `Desktop\claude\TweetWiper\extension`. Pin TweetWiper from the puzzle-piece menu so it shows next to the address bar.
3. 🔴 **Sign in to x.com** in a normal tab, any way you like (Google button included).
4. 🔴 **Click the TweetWiper icon** while that x.com tab is in front. It should say "Connected to x.com". If it tells you to reload the tab, reload it once and click the icon again.
5. 🔴 **Give it your posts.** Either:
   - **Load archive file(s)**: unzip the archive, pick `data/tweets.js` (also `tweets-part1.js`, `tweets-part2.js`... if those exist). You can pick several at once.
   - **Scan this profile page**: open `x.com/YOURNAME/with_replies` (your profile, "Replies" tab), then click Scan. It scrolls the page by itself and collects what it sees. Leave the tab alone while it scrolls.
6. 🔴 **Dry run.** Leave "Dry run" ticked and press **Start**. The log tells you how many it would delete. Nothing is deleted yet.
7. 🔴 **Do it for real.** Untick "Dry run", type `DELETE` in the box, press **Start**. Keep the tab open. It deletes about one post a second, so 4,000 posts take a little over an hour. If X tells it to slow down, it waits and continues on its own.
8. **It keeps going by itself.** With "Keep going on its own" ticked (the default) it reloads your profile after each pass, scans for older posts X was hiding, deletes those, and repeats until two scans in a row find nothing. The log then says FINISHED. The tab must stay open and on your profile page the whole time. Untick that box if you'd rather run one pass at a time; then press **Scan** and **Start** yourself until Scan finds 0. Anything in "failed" can be retried with **Retry failed** then **Start**.

## What good looks like

- Popup says "Connected to x.com".
- After loading the archive, "queued" roughly matches the post count on your profile.
- During the run, "gone" climbs and the log prints a line every 20 posts.
- At the end your profile shows no posts and no replies.

## Things to know

- **Permanent.** Deleted posts cannot be recovered. The archive zip is the only copy.
- **Progress is saved.** Close the popup, reload the tab, even restart the browser; press Start again and it carries on where it left off.
- **"Also remove reposts"** is ticked by default. Untick it before loading or scanning if you want reposts kept.
- **Why not the official X API?** The free tier allows only a handful of deletes per day. This tool uses the same internal calls the X website itself makes when you click Delete, so it is fast. If X changes those internals the tool may stop working until it is updated.
- **Scan only sees what X shows.** X shows roughly the newest 3,200 posts on a profile. As posts are deleted, older ones appear, which is why auto mode reloads and re-scans. The archive route gets everything in one go.
- **Likes, bookmarks and DMs** are not touched.

## Files

- `extension/manifest.json`: extension setup.
- `extension/content.js`: the worker that runs inside the x.com tab (scan + delete).
- `extension/popup.html`, `extension/popup.js`: the little window with the buttons.
