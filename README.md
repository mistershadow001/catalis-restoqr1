# RestoQR Cloud

Static restaurant QR ordering product for Netlify or Vercel.

## What is included

- Super admin panel for restaurant activation, deactivation, QR control, and subscriptions.
- Restaurant registration with manual PhonePe payment flow.
- Restaurant owner panel for menu, add-ons, table QR links, kitchen, and billing.
- One main restaurant QR by default. Customers enter their table number after scanning.
- Customer QR ordering page with table number, add-ons, owner payment QR, and order placement.
- Kitchen screen for live order status.
- Billing screen for payment checking, paid marking, and table closing.
- Common restaurant item picker so owners can add popular items quickly and edit only prices.
- Existing menu item prices can be changed directly from the owner menu panel.
- Google review prompt after an order is delivered. Collect the restaurant's Google review link during registration or in owner settings.
- Firebase-ready shared data layer, with local demo mode until Firebase is configured.

## Open locally

Open `index.html` in a browser. Demo mode works on the same browser/device.

## Configure Firebase later

1. Create a Firebase project.
2. Enable Realtime Database.
3. Copy the web app config into `firebase-config.js`.
4. Deploy the folder to Netlify or Vercel.

When `databaseURL` and `apiKey` are filled, all devices share the same live restaurant/order data.

## Default demo access

- Super admin passcode: `9090`
- Restaurant owner demo PIN: `1234`

## Suggested Firebase Realtime Database rules for early testing

These are open for testing only. Tighten before selling publicly.

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```
