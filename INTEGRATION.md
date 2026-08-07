# Push notifications + legal — integration

Drop-in addition to the existing Wandrlust repo. Copy the folders in, run one
migration, generate keys, wire four call sites.

---

## 1. Copy files

```
public/sw.js                              → public/sw.js
public/legal/*.md                         → public/legal/
src/services/pushService.ts               → src/services/
src/components/PushSettings.tsx           → src/components/
src/components/LegalGate.tsx              → src/components/
src/legal/*.md                            → src/legal/          (source copies)
server/pushRoutes.ts                      → server/
scripts/generateVapidKeys.ts              → scripts/
supabase_migration_05_push_and_legal.sql  → repo root
```

## 2. Install and generate keys

```bash
npm install web-push
npx tsx scripts/generateVapidKeys.ts
```

Paste the output into `.env`. The **public** key ships in the bundle (expected);
the **private** key must never leave the server.

## 3. Run the migration

Paste `supabase_migration_05_push_and_legal.sql` into the Supabase SQL Editor.
Single transaction, additive, requires migrations 01–04 first.

## 4. Wire the call sites

**`server.ts`** — register the routes:

```ts
import { registerPushRoutes } from './server/pushRoutes';
// alongside registerWeatherRoutes(app):
registerPushRoutes(app);
```

**`src/main.tsx`** — register the service worker on boot:

```ts
import { registerServiceWorker } from './services/pushService';
if (import.meta.env.PROD) registerServiceWorker();
```

**`src/App.tsx`** — mount the legal gate:

```tsx
import { LegalGate, LegalDocumentModal } from './components/LegalGate';

const [legalDoc, setLegalDoc] = useState<
  'privacy_policy' | 'terms_of_service' | 'safety_disclaimer' | null
>(null);

// near the end of the render tree:
<LegalGate onOpenFullText={setLegalDoc} />
<LegalDocumentModal kind={legalDoc} onClose={() => setLegalDoc(null)} />
```

**`src/components/SettingsPanel.tsx`** — put push controls above the existing
alert toggles:

```tsx
import { PushSettings } from './PushSettings';

<section>
  <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 px-2.5 mb-2">
    Notifications
  </h3>
  <PushSettings center={center} />
</section>
```

Also add links to the legal documents in the settings footer.

## 5. Keep the alert location fresh

Call this when the map centre changes materially, so the matcher knows roughly
where to alert you. Coordinates are rounded to ~1 km before they leave the
device.

```ts
import { updateAlertLocation } from './services/pushService';
updateAlertLocation(center[0], center[1]);
```

## 6. Schedule the matcher and dispatcher

In Supabase, enable `pg_cron`, then:

```sql
select cron.schedule('queue-weather', '*/10 * * * *',
  $$select public.queue_weather_alerts()$$);
select cron.schedule('queue-zones', '*/30 * * * *',
  $$select public.queue_zone_alerts()$$);
select cron.schedule('purge-queue', '0 4 * * *',
  $$select public.purge_notification_queue()$$);
```

Then call the dispatcher every few minutes from any scheduler:

```bash
curl -X POST https://yourdomain.com/api/push/dispatch \
  -H "x-dispatch-secret: $PUSH_DISPATCH_SECRET"
```

## 7. Icons

The service worker references `/icons/*.png`. Add at minimum:

```
public/icons/icon-192.png     app icon
public/icons/badge.png        monochrome, Android status bar
public/icons/alert-fire.png
public/icons/alert-flood.png
public/icons/alert-storm.png
```

Missing icons degrade gracefully — the notification still shows.

---

## How delivery works

```
weather_alerts (cached from NWS / ECCC)
        │
        │  queue_weather_alerts()   ← pg_cron, spatial join
        ▼
notification_queue (pending)
        │
        │  POST /api/push/dispatch  ← your scheduler
        ▼
push_subscriptions → Web Push → device
```

Queue-driven rather than fire-and-forget. A push outage delays alerts instead
of losing them, and you get an audit trail — which you want the first time
somebody says they never received a fire warning.

**Design decisions worth knowing:**

- **Life-safety alerts ignore quiet hours.** A tornado warning at 3am is
  exactly the notification you want at 3am. Booking updates are not.
- **Dead subscriptions are deleted, not retried.** A 404/410 from the push
  service means the browser discarded it permanently. Five consecutive
  failures also triggers removal.
- **`pushsubscriptionchange` is handled.** Browsers rotate subscriptions; if
  you ignore that event, users silently stop receiving alerts and everything
  *looks* fine. That's the worst failure mode for a safety feature.
- **Clients cannot write to the queue.** No insert policy exists for
  `authenticated` — otherwise any user could push to any other user.

---

## Testing

```bash
# Locally, Chrome/Edge (localhost counts as a secure context):
npm run dev
# Settings → Notifications → Turn on alerts → Test

# Verify the queue fills:
select public.queue_weather_alerts();
select status, family, count(*) from public.notification_queue group by 1,2;
```

**iOS:** Web Push only works for apps added to the Home Screen (16.4+).
`PushSettings` detects this and tells the user to install rather than showing a
button that silently fails.

---

## The legal documents

Three markdown files in `public/legal/`, written to be read by actual humans:

| Document | Core message |
| --- | --- |
| `privacy-policy.md` | Name, username, email, password, location stored. Never sold, never shared with third parties. Secure database. |
| `terms-of-service.md` | We are not liable for your safety on public or private land. |
| `safety-disclaimer.md` | The app is a tool, not a guardian angel. Augment your overlanding, don't rely on it. |

`LegalGate` blocks the app until a signed-in user accepts. Acceptance is
recorded **per document version** — so amending the terms re-prompts everyone,
rather than silently claiming they agreed to text that didn't exist yet.

**Before you edit them:** replace `[your-contact-email@example.com]` and
`[DATE]`, and have a lawyer review. I've written these to say what you asked
them to say, clearly. I am not a lawyer, these are not legal advice, and
whether a liability waiver actually holds up depends on your jurisdiction —
consumer protection law limits what disclaimers can do in many places.