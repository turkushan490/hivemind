# HiveMind for Home Assistant

Use your HiveMind canvases from Home Assistant:

- **Assist conversation agent per canvas.** Talk or type to a canvas from the Assist dialog, the companion app or a voice satellite.
- **`hivemind.run_canvas` action.** Runs a canvas with any text and returns its answer, for use in automations and scripts.
- **Button per canvas.** Pressing it runs the canvas and fires a `hivemind_response` event with the answer.

It talks to HiveMind's OpenAI-compatible API (`/v1/chat/completions`) over plain HTTP on your LAN. It needs no extra Python packages, so it works on **Home Assistant OS** and **Home Assistant Container (Docker)** alike. Home Assistant 2024.12 or newer is required.

## 1. Make an API token in HiveMind

In HiveMind, open **Settings → API tokens**, create a token named "Home Assistant", and copy it (it starts with `hm_`). The integration sees the canvases of the user who made the token.

**Settings → OpenAI API** shows the base URL and the id of every canvas.

## 2. Install

### Manual (HA OS and Docker)

1. Copy the folder `custom_components/hivemind` from here into the `custom_components` folder of your Home Assistant configuration, so that you get `config/custom_components/hivemind/manifest.json`.
   - **HA OS:** use the *File editor* or *Samba share* add-on. The config folder is `/config`.
   - **Docker:** use the folder you mounted as `/config`, for example `/mnt/user/appdata/homeassistant` on Unraid.
2. Restart Home Assistant.

### HACS (custom repository)

HACS installs integrations from a repository whose root holds `hacs.json` and `custom_components/`. HiveMind keeps the integration in this subfolder, so first publish this folder (`integrations/home_assistant`) as a repository of its own. One way is `git subtree split --prefix integrations/home_assistant -b ha-integration`, then push that branch to a new repository. Then:

1. In HACS, open **⋮ → Custom repositories**, add that repository's URL, and pick the type **Integration**.
2. Install **HiveMind** and restart Home Assistant.

## 3. Add the integration

Go to **Settings → Devices & services → Add integration → HiveMind** and enter:

- **HiveMind address**, for example `http://192.168.1.10:4820` (the port is 4820 unless you changed it; `/v1` at the end is fine too).
- **API token**: the `hm_…` token from step 1.

If HiveMind runs on the same Unraid server as a Home Assistant container, use the server's LAN IP address, not `localhost`.

To choose which canvases become agents and buttons, and what text a button press sends, use **Configure** on the integration. New canvases show up after you reload the integration.

## Using it

### Voice / Assist

Open **Settings → Voice assistants**, pick or create an assistant, and set **Conversation agent** to the canvas, for example *HiveMind Kitchen helper*. Whatever you say becomes the canvas question, and the canvas's Final answer is spoken back.

A canvas can control your home itself if it contains a HiveMind **Home Assistant** action block (connect HiveMind to Home Assistant in HiveMind → Settings → Home Assistant).

### Action in automations and scripts

```yaml
action: hivemind.run_canvas
data:
  canvas: Kitchen helper        # canvas id or name
  text: "What can I cook with eggs, spinach and feta?"
response_variable: hivemind
```

Then use `{{ hivemind.response }}`, for example in a notification:

```yaml
action: notify.mobile_app_phone
data:
  message: "{{ hivemind.response }}"
```

If you added more than one HiveMind server, add `config_entry_id` to choose one.

### Buttons

`button.hivemind_run_<canvas>` runs the canvas with the configured button text (default "Go"). The answer comes back two ways:

- the `last_response` attribute (first 1000 characters);
- the `hivemind_response` event, with `canvas`, `canvas_name`, `text` and `response`.

```yaml
triggers:
  - trigger: event
    event_type: hivemind_response
    event_data:
      canvas_name: Morning briefing
actions:
  - action: tts.speak
    target:
      entity_id: tts.piper
    data:
      media_player_entity_id: media_player.kitchen
      message: "{{ trigger.event.data.response }}"
```

## Troubleshooting

- **Cannot reach HiveMind.** Open `http://<address>:4820/api/health` from a browser on the same network. From Home Assistant Docker, the container must be able to reach that IP address; with host or bridge networking this usually works.
- **HiveMind refused the token.** The token was revoked. Home Assistant asks for a new one under *Repairs* / *Re-authenticate*.
- **The answer takes long.** A canvas with several local models can take minutes, because each model may have to load first. The integration waits up to 10 minutes. Assist satellites can give up sooner, so keep voice canvases small and fast.
- **Errors in HiveMind.** Every failed run is listed in HiveMind's **Problems** tab.

## Development

The tests use the Home Assistant test harness:

```bash
python -m venv venv && . venv/bin/activate
pip install pytest-homeassistant-custom-component hassil home-assistant-intents
cd integrations/home_assistant && pytest
```
