# ADL exercise grading

A small website for marking the ADL exercises. You paste the student list of a session once. The site then gives you a sheet per exercise where you tick Missing, mark Pass or Fail, and leave a comment. Every change is written straight into a Google Sheet, one tab per session and exercise (5 sessions × 3 exercises = 15 tabs).

The website is static and lives on GitHub Pages. A small Google Apps Script attached to the Google Sheet stores the data. No student data is ever stored in this repository.

```
index.html            the page
style.css             the look
config.js             title, term and the Apps Script URL  ← you edit this
parse.js              reads the pasted student list
app.js                everything else
apps-script/Code.gs   goes into the Google Sheet, not onto GitHub Pages
```

You can try the site before setting anything up. Open `index.html` in a browser: while `SCRIPT_URL` in `config.js` is empty, it runs in demo mode and keeps everything in that browser.

---

## Part 1: The Google Sheet

### 1. Get a sheet you can edit

The script has to live in a sheet you own or can edit. If the course sheet is view-only for you, open it and use **File → Make a copy**, or create a new blank sheet. The script creates its own tabs and doesn't touch existing ones.

### 2. Add the script

1. In the sheet, open **Extensions → Apps Script**.
2. Delete the placeholder code in `Code.gs`.
3. Paste the full contents of `apps-script/Code.gs` from this repository.
4. Click the save icon.

### 3. Create the 15 tabs

1. In the Apps Script editor, pick `setupTabs` from the function dropdown next to **Run**, then click **Run**.
2. Google asks for permission the first time. Choose your account. You'll see "Google hasn't verified this app", because it's your own unpublished script. Click **Advanced → Go to … (unsafe)**, then **Allow**.
3. Back in the sheet you should now have tabs named `Tue 10-12 Ex1`, `Tue 10-12 Ex2`, … `Thu 14-16 Ex3`.

After a reload, the sheet also has a **Grading** menu that runs the same step.

### 4. Set a passphrase

The website is public, so the script only accepts requests that carry the passphrase.

1. In the Apps Script editor, click the gear icon (**Project Settings**).
2. Scroll to **Script Properties** and click **Add script property**.
3. Property: `PASSPHRASE`. Value: a long phrase only you and your co-tutors know.
4. Click **Save script properties**.

Never put the passphrase into `config.js` or anywhere else in the repository.

### 5. Deploy the script as a web app

1. Click **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Set **Execute as** to **Me** and **Who has access** to **Anyone**.
   "Anyone" means anyone can *reach* the script. Without the passphrase, it answers every request with an error and shows no data.
4. Click **Deploy** and copy the **Web app URL**. It ends in `/exec`.

---

## Part 2: GitHub Pages

### 6. Put the URL into config.js

Open `config.js` and paste the URL:

```js
SCRIPT_URL: 'https://script.google.com/macros/s/AKfy…/exec',
```

You can also change `TITLE` and `TERM` here.

### 7. Create the repository

**In the browser (no Git needed):**

1. On github.com click **+ → New repository**. Name it, for example, `adl-grading`. Public is required for GitHub Pages on a free account. Don't add a README.
2. On the empty repository page click **uploading an existing file**.
3. Drag in every file and the `apps-script` folder: `index.html`, `style.css`, `config.js`, `parse.js`, `app.js`, `.nojekyll`, `README.md`, `apps-script/`.
   The `.nojekyll` file is hidden on most systems. If you can't see it, skip it; the site works without it.
4. Click **Commit changes**.

**Or with Git:**

```bash
cd adl-grading
git init
git add .
git commit -m "Grading site"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/adl-grading.git
git push -u origin main
```

### 8. Switch on GitHub Pages

1. In the repository, go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose branch **main** and folder **/ (root)**, then **Save**.
4. After a minute or two the page shows your address, something like `https://YOUR-NAME.github.io/adl-grading/`.

### 9. Open it

Open the address, enter the passphrase, and pick a session. Each browser remembers the passphrase until you click **Lock this computer** at the bottom of the page. Use that on shared computers in the lab.

---

## Using it

1. Pick the session, open **Student list**, and paste the students.
2. Check the preview on the right. Groups, warnings, and lines without a recognisable idm show up there.
3. Click **Save list to Ex1, Ex2, Ex3**. The same groups go into all three exercise tabs.
4. Mark each exercise in its tab. Changes save on their own. The **Sync** box at the top shows "Saving…", "All saved to the sheet", or "Offline", in which case it keeps retrying.
5. **Overview** shows all exercises side by side and can download a CSV.

The paste box understands these formats, one student per line:

```
1	Anna Berger	ab12cdef        ← straight from a spreadsheet; the group
	Ben Croft	cd34efgh           number only on the first member is fine
2, Clara Diaz, ef56ghij          ← comma or semicolon separated
Group 3                          ← a heading line, members below
Dan Eck (gh78ijkl)               ← idm in brackets, or an @fau.de address
```

If there are no group numbers at all, blank lines between blocks count as groups. If there are neither, the site splits the list into groups of 3 (and 2) in order and warns you.

You can save the list again later, for example when someone joins or leaves. Marks are kept for everyone who is still on the list, matched by idm. Before removing students who are no longer on it, the site asks you to confirm.

The tabs can also be edited directly in Google Sheets. Click **Reload from sheet** on the website to see those changes.

---

## Changes later

**After editing `Code.gs`**, you have to publish a new version or the website keeps talking to the old one: **Deploy → Manage deployments**, the pencil icon, **Version → New version**, then **Deploy**. The URL stays the same.

**Adding the video** as a fourth sheet per session: in `Code.gs`, remove the `//` in front of the `Video` line in `EXERCISES`. Run `setupTabs` again and publish a new version as above. The website picks it up by itself.

**Changing sessions** works the same way, in the `SESSIONS` list. Don't change the `id` of a session or exercise once it has data; the `short` name is what the tab is called.

**After editing files on GitHub**, Pages updates within a minute or two. Force-reload the page (Ctrl+Shift+R) if you still see the old version.

---

## When something goes wrong

| What you see | What to do |
|---|---|
| "Wrong passphrase" | Check the `PASSPHRASE` script property for typos or extra spaces. |
| "No PASSPHRASE is set" | Step 4 is missing or wasn't saved. |
| "The sheet script sent back a web page" | The deployment isn't set to **Anyone**, or `config.js` has the editor URL instead of the `/exec` URL. |
| Changes in Code.gs have no effect | Publish a new version (see "Changes later"). |
| "No student with idm …" | Someone changed the tab in Google Sheets. Click **Reload from sheet**. |
| Still "Demo mode" | `SCRIPT_URL` in `config.js` is empty, or the browser cached the old file. Force-reload. |

---

## A note on student data

Names and idm are personal data. They only live in your Google Sheet, never in this repository. The page has `noindex` set so search engines skip it, and nothing is readable without the passphrase. Keep the sheet's own sharing settings limited to the tutors, and check with your chair whether a Google Sheet is acceptable for grades under your university's data protection rules.
