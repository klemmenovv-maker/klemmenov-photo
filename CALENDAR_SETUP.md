# Booking calendar

`/book/` now supports a read-only month calendar without enabling payments.
Set `booking_schedule_api` in `content.json` to the deployed Worker URL and rebuild
with `python3 tools/build.py`. The existing `booking_api` payment gate is unchanged.

## Availability

The mixed Google calendar “368” contains both Project K studio bookings and work.
Titles containing `Project K` block the studio. Photographer-name matches also block
the photographer. Other opaque events conservatively block the photographer, except
other team members' OFF entries and explicit Roma projects. Transparent and cancelled
events do not block. This is a title convention, not an authoritative staff assignment;
review ambiguous shared events with the owner before using availability for automatic
confirmation. All-day ends are exclusive and use Dubai time.

The interface shows only free start times by default. A disclosure shows why other
intervals cannot be selected. Other-location requests need only photographer availability;
Project K needs both resources. The duration can also be changed beside the calendar. Two day tracks show photographer and studio occupancy, including fully booked/closed days. A selected session is highlighted for its full duration. The chosen start and location are included in WhatsApp.
A selection does not reserve a studio or create a calendar event.

Owner-confirmed hours: 10:00–21:00; Wednesday 10:00–18:00; Friday closed.
Notice: 48 hours. Buffer is zero: sessions can be adjacent, as requested by the owner.
Dates use Asia/Dubai. Duration comes from the service quote.

## Google connection

Supply Worker secrets `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`GOOGLE_OAUTH_REFRESH_TOKEN`. Existing service-account mode remains supported.
Set `GOOGLE_CALENDAR_ID` to the mixed calendar. Optionally set
`GOOGLE_PERSONAL_CALENDAR_ID` to add owner-calendar free/busy.
The shared calendar ID must be configured server-side, not in browser code.

For a local, one-time owner connection, register exactly
`http://127.0.0.1:8977/oauth/callback` in the OAuth web client. Add the owner as a test
user if the app is in Testing. Run:

```
node tools/google-connect.mjs /absolute/google-oauth.PRIVATE.json /absolute/google-tokens.PRIVATE.json /absolute/auth-url.PRIVATE.txt
```

Open the generated URL locally and approve Calendar event read access. The helper
uses state and PKCE, listens only on loopback, saves credentials with 0600 permissions
and never prints tokens. Put the values in Cloudflare secrets through stdin; never
commit credential files. Calendar scopes in External Testing typically produce
refresh tokens that expire after 7 days: plan production authorization before promising
persistent availability. A service-account key is not needed for this OAuth path.

`SCHEDULE_ONLY=true` disables checkout/payment webhooks in this deployment. Do not
change it until payments, approved terms and booking write policy are separately ready.
On any provider error `/schedule` fails closed (503), and the visitor can request a
date through WhatsApp. Raw titles, event IDs, descriptions and contacts never leave
`/schedule`.

## Checks

Run `npm test`, `python3 -m unittest tests.test_site`, and
`python3 tools/check_site.py`. New schedule tests cover OAuth refresh/redaction,
pagination, resource separation, all-day bounds, failures, buffering and weekly hours.
Preview snapshots and private credentials belong outside this public checkout.

## Final owner decision: photographer only
The public calendar now filters only photographer availability from 368. Studio-only
Project K events do not block an appointment. The studio/location is discussed after
the WhatsApp request. Location controls and the studio track are removed from the UI.
The server still computes both resources for compatibility, but the public page uses
only `photographer`. No automatic studio reservation is made.
