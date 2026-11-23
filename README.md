# GRIMOIRE

**Live Site:** [https://sumith2425.github.io/Grimoire/](https://sumith2425.github.io/Grimoire/)

I wanted to read *Swordmaster's Youngest Son*, but the website I started reading on was full of bugs. When I pressed "Next" after Chapter 301, it randomly took me straight to Chapter 361. On top of that, some chapter URLs didn't even match the actual chapter numbers, and there wasn't a proper scrollable chapter list to select from. 

I got frustrated with the broken navigation and built this site so I could actually read without interruptions.

### What it has
- **Multiple Novels:** Swordmaster's Youngest Son, Eternally Regressing Knight, Talent-Swallowing Magician, Chronicles of the Heavenly Demon, Dungeon Defense (WN), The Academy's Black-Haired Foreigner, My Exclusive Tower Guide and The Earth's Chosen Savior — each read from its translator's own free chapters.
- **Fixed Navigation:** Each novel's chapter list is built from the translator's actual posts, so Next and Previous always land on the right chapter and skip chapters that don't exist. The next chapter is prefetched in the background so "Next" opens instantly.
- **Scrollable & Searchable Chapter List:** A single combo-box (type a number or use ↑ / ↓ + Enter) and full chapter index to jump to any chapter directly.
- **Clean Black Reader:** Pure black background, adjustable font sizes, keyboard scrolling (← / →), and translator notes/clutter stripped out at the bottom.
- **Auto-Scroll:** Press Space (or tap the text on mobile) to start/pause, adjust the speed with − / +. With ⏭ enabled it moves on to the next chapter automatically when you reach the end.
- **Reading History:** Automatically saves the last chapter you read, your scroll position, and recently viewed chapters.
- **Support the Translator:** Every chapter ends with a credit to its translator and links to their own site and donation pages (Ko-fi, Patreon, etc.).
- **Accounts (optional):** Log in or sign up (email/password or Google) to keep your progress across devices. You can still read without an account — progress is then kept in your browser. Signing up saves your current browser progress to the new account; logging in loads the account's progress.

### Running Locally
The novel list is loaded from `novels.json`, so serve the folder instead of opening `index.html` directly:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

### Setting Up Accounts (Firebase)
The site is static (GitHub Pages), so accounts and saved progress use Firebase's free tier. Until `firebase-config.js` is filled in, the login button stays hidden and the site works in guest mode.

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com) (Google Analytics is not needed).
2. **Authentication → Sign-in method:** enable **Email/Password** and **Google**.
3. **Authentication → Settings → Authorized domains:** add `sumith2425.github.io` (`localhost` is already there).
4. **Firestore Database → Create database** (production mode), then **Rules:** paste the contents of [`firestore.rules`](./firestore.rules) and publish.
5. **Project settings → General → Your apps → Web (`</>`):** register an app and copy its `firebaseConfig` values into [`firebase-config.js`](./firebase-config.js).

The config values are public identifiers, not secrets — the Firestore rules ensure each user can only read and write their own progress.

### Contributing & Adding Novels
This is just a personal project, but feel free to make open-source contributions to it. 

I plan to add more novels over time. If you want to add a novel yourself, add an entry to [`novels.json`](./novels.json) and open a PR — just make sure it uses the **best available translation**, not just any random or machine translation. Please only add translations whose translator doesn't forbid reposting, and that aren't officially licensed in English.

The translation must be hosted on **WordPress.com** (the site is read through the WordPress.com public API). Useful `novels.json` fields:

| Field | Purpose |
| :--- | :--- |
| `siteDomain` | The translator's WordPress.com site, e.g. `babayaga017.wordpress.com` |
| `category` | Category slug, for sites that host several novels |
| `chapterPattern` | Regex whose first group is the chapter number, for titles that don't start with "Chapter N" (e.g. `"^Talent Swallowing Magician Ch\\.?\\s*(\\d{1,4})\\b"`) |
| `infoSlug` | Slug of the translator's novel page; its first image is used as the cover |
| `translatorName`, `translatorUrl`, `supportLinks` | Credit and donation links shown under every chapter |
| `translationStatus` | Short note shown on the novel page (e.g. where free chapters end) |
| `defaultChapter`, `knownMaxChapter` | First chapter for new readers, and a fallback last chapter if the source can't be reached |

If you want me to add a novel instead, drop it into [`RECOMMENDATIONS.md`](./RECOMMENDATIONS.md) using this format:

| Novel Name | Best Translation / Source | Done |
| :--- | :--- | :--- |
| Swordmaster's Youngest Son | punisher87 (blackseatls) | [x] |
| *Your Novel Here* | *Translator / Site* | [ ] |
