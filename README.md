# Attendance Gathering

Students check in to class by scanning a QR code on the projector. The code changes every 5 seconds, so a photo sent to an absent friend has expired before it can be used. Scanning gives the student's phone a single-use ticket with 3 minutes to type their name and student ID.

Runs free on Cloudflare Workers with a D1 database. Students install nothing.

## Using it in class

1. Open the app on the laptop connected to the projector and sign in with your passcode.
2. Create a named attendance sheet, for example "CS101 Week 3 lecture".
3. Press **Start and show QR**, then **Full screen**. The live count shows how many have checked in.
4. Press **Stop check-in** when done. Students who already scanned can still finish within their 3 minutes.
5. On the sheet page, review check-ins, remove any you reject, and **Download CSV** (opens in Excel or Google Sheets).

Every sheet stays stored in the cloud database. You can rename, reopen, re-download or delete it from the home page at any time.

### What the flags mean

- **same device as another check-in**: a second student ID was submitted from a phone that already checked someone in for this sheet. This is the usual sign of a student checking in a friend.

A student ID can only be checked in once per sheet.

## Deploying (one time, about 10 minutes)

You need a free Cloudflare account and Node.js 20 or newer.

```bash
npm install
npx wrangler login                    # opens the browser to sign in to Cloudflare
npx wrangler d1 create attendance     # prints a database_id
```

Paste the printed `database_id` into `wrangler.jsonc`, then:

```bash
npx wrangler secret put LECTURER_PASSCODE   # choose your lecturer passcode
npm run deploy                              # creates the tables and publishes the app
```

The app is then live at `https://attendance-gathering.<your-subdomain>.workers.dev`. A custom domain can be added later in the Cloudflare dashboard. Changing the passcode signs every lecturer browser out.

## Developing

```bash
echo 'LECTURER_PASSCODE=testpass' > .dev.vars
npm run dev        # http://localhost:8787
npm run typecheck
npm test
```

## How it works

- `public/present.html` gets the sheet's secret once, then computes a fresh token every 5 seconds in the browser: an HMAC of the sheet id and the time window. Rotating the code costs no server requests.
- `GET /c/:sheet/:window/:token` (the link in the QR) accepts the current or previous window only. It issues a 3-minute single-use ticket in an HttpOnly cookie and redirects to `/checkin`, removing the token from the address bar.
- `POST /api/checkin` consumes the ticket and stores the record. A long-lived device cookie is used for the "same device" flag.
- Tables: `sheets`, `tickets`, `records` (see `migrations/`).

`public/vendor/qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT).
