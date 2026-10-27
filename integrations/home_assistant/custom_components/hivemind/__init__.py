"""HiveMind: use your HiveMind canvases from Home Assistant.

Every saved canvas becomes an Assist conversation agent and a button, and the
hivemind.run_canvas action runs any canvas and returns its answer.
"""

from __future__ import annotations

from dataclasses import dataclass

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.const import CONF_TOKEN, CONF_URL, Platform
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady, HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .api import Canvas, HiveMindAuthError, HiveMindClient, HiveMindError
from .const import ATTR_CANVAS, ATTR_CONFIG_ENTRY, ATTR_TEXT, CONF_CANVASES, DOMAIN, SERVICE_RUN_CANVAS

PLATFORMS = [Platform.BUTTON, Platform.CONVERSATION]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

RUN_CANVAS_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_CANVAS): cv.string,
        vol.Required(ATTR_TEXT): cv.string,
        vol.Optional(ATTR_CONFIG_ENTRY): cv.string,
    }
)


@dataclass
class HiveMindData:
    """What a loaded entry keeps: the client and the canvases found at setup."""

    client: HiveMindClient
    canvases: list[Canvas]

    def shown(self, entry: ConfigEntry) -> list[Canvas]:
        """The canvases chosen in the options (all when none were chosen)."""
        chosen = entry.options.get(CONF_CANVASES)
        return [c for c in self.canvases if not chosen or c.id in chosen]


type HiveMindConfigEntry = ConfigEntry[HiveMindData]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Registers the hivemind.run_canvas action once."""

    async def run_canvas(call: ServiceCall) -> ServiceResponse:
        entries = [e for e in hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED]
        wanted = call.data.get(ATTR_CONFIG_ENTRY)
        if wanted:
            entries = [e for e in entries if e.entry_id == wanted]
        if not entries:
            raise ServiceValidationError("No HiveMind server is set up (or it is not loaded)")
        data: HiveMindData = entries[0].runtime_data
        canvas = call.data[ATTR_CANVAS]
        # Accept a canvas name as well as its id.
        for c in data.canvases:
            if canvas in (c.id, c.name) or canvas.lower() == c.name.lower():
                canvas = c.id
                break
        try:
            answer = await data.client.run(canvas, call.data[ATTR_TEXT])
        except HiveMindError as err:
            raise HomeAssistantError(f"HiveMind: {err}") from err
        return {"response": answer, "canvas": canvas}

    hass.services.async_register(
        DOMAIN,
        SERVICE_RUN_CANVAS,
        run_canvas,
        schema=RUN_CANVAS_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: HiveMindConfigEntry) -> bool:
    """Connects to HiveMind and loads its canvases."""
    client = HiveMindClient(async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_TOKEN])
    try:
        canvases = await client.canvases()
    except HiveMindAuthError as err:
        raise ConfigEntryAuthFailed(str(err)) from err
    except HiveMindError as err:
        raise ConfigEntryNotReady(str(err)) from err
    entry.runtime_data = HiveMindData(client=client, canvases=canvases)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_reload))
    return True


async def _reload(hass: HomeAssistant, entry: HiveMindConfigEntry) -> None:
    """Options changed (or new canvases wanted): load again."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: HiveMindConfigEntry) -> bool:
    """Unloads the entities."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
