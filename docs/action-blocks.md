# Action blocks

Action blocks do something outside HiveMind and pass a readable result on to the next block.

- **Status and errors:** they show their status on the canvas like every other block (working, a status line, done or error).
- **Problems log:** every failure (unreachable host, wrong token, HTTP error, invalid JSON) stops the block with a clear message and is logged in **Problems**.
- **Timeout:** each call gives up after 30 seconds.
- **Cancel:** stopping a run cancels the call.

## Templates

Text fields can use these placeholders:

| Placeholder | Becomes |
|---|---|
| `{{input}}` | The text of the last block wired in. With only the Question wired in, the question. |
| `{{question}}` | The question of the run. |
| `{{inputs}}` | Every wired-in answer, each under its block name. |

How the values are inserted depends on the field:

- **JSON templates** (a body that starts with `{` or `[`): values are JSON-escaped, so `{"message": "{{input}}"}` stays valid whatever the text contains.
- **URLs:** values are URL-encoded.
- **Everything else:** values are inserted as they are.

## Home Assistant

First connect Home Assistant in **Settings → Home Assistant**:

1. Enter its address, for example `http://192.168.1.20:8123`.
2. Paste a long-lived access token (Home Assistant: your profile → Security → Long-lived access tokens).
3. Press **Test connection**.

The token is stored encrypted (AES-256-GCM), like provider keys.

The block has two modes:

- **Read states:** reads one or more entities (one per line or comma-separated; pick them from the list) and passes lines like `sensor.living_room (Living room): 21.5 — unit_of_measurement °C` on, for example to a model that answers "Is it warm inside?".
- **Call a service:** calls a service such as `light.turn_on` or `notify.mobile_app_phone` with JSON data, for example `{"entity_id": "light.kitchen", "brightness_pct": 60}` or `{"message": "{{input}}"}`. It passes on which entities changed.

Typical canvases:

- **Question → HA (read) → model → Final answer.** Questions about your home answered from live sensor values.
- **Question → model (writes a short message) → HA (call `notify.…`) → Final answer.** The AI sends you a notification.

## Webhook / HTTP

These are the block's settings:

- **Method:** GET, POST, PUT, PATCH or DELETE.
- **URL:** `{{…}}` placeholders are URL-encoded.
- **Headers:** one `Name: value` per line.
- **Body:** a template. Without one it sends `{"text": "{{input}}", "question": "{{question}}"}`. A JSON body gets `content-type: application/json`, anything else `text/plain`.

The response body is passed on (JSON is pretty-printed, up to 100,000 characters). Any non-2xx status is an error.

Use it to trigger n8n, Node-RED, Home Assistant webhooks or IFTTT, or to fetch data from an API for the next model.

## Discord

Paste a channel webhook URL (Discord: Edit channel → Integrations → Webhooks → Copy URL) and optionally a message template (default `{{input}}`). Long answers are split into several messages of up to 2000 characters. Mentions are disabled, so an AI answer can't ping `@everyone`. The block passes the message on.

## Good to know

- **Saved with the canvas:** Webhook headers and Discord webhook URLs are stored in the canvas, so they also end up in canvas exports. Only the Home Assistant token is kept separately and encrypted.
- **Network access:** the HiveMind server makes these calls, not your browser, so the server must be able to reach the address.
