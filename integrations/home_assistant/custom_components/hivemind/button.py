"""A button per canvas: pressing it runs the canvas with the configured text."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import HiveMindConfigEntry
from .api import Canvas, HiveMindAuthError, HiveMindError
from .const import CONF_BUTTON_TEXT, DEFAULT_BUTTON_TEXT, EVENT_RESPONSE
from .entity import device_info, unique_id

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: HiveMindConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    """One button per shown canvas."""
    data = entry.runtime_data
    async_add_entities(HiveMindButton(entry, canvas) for canvas in data.shown(entry))


class HiveMindButton(ButtonEntity):
    """Runs a canvas. The answer is fired as a hivemind_response event and kept as an attribute."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:hexagon-multiple-outline"

    def __init__(self, entry: HiveMindConfigEntry, canvas: Canvas) -> None:
        self._entry = entry
        self._canvas = canvas
        self._attr_name = f"Run {canvas.name}"
        self._attr_unique_id = unique_id(entry, canvas, "button")
        self._attr_device_info = device_info(entry, entry.runtime_data.client.url)
        self._last: dict[str, Any] = {"canvas_id": canvas.id}

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return self._last

    async def async_press(self) -> None:
        text = self._entry.options.get(CONF_BUTTON_TEXT) or DEFAULT_BUTTON_TEXT
        try:
            answer = await self._entry.runtime_data.client.run(self._canvas.id, text)
        except HiveMindError as err:
            # A revoked token: Home Assistant asks for a new one instead of failing on every press.
            if isinstance(err, HiveMindAuthError):
                self._entry.async_start_reauth(self.hass)
            self._last = {"canvas_id": self._canvas.id, "error": str(err)}
            self.async_write_ha_state()
            raise HomeAssistantError(f"HiveMind canvas {self._canvas.name}: {err}") from err
        # States are limited in size; the full answer goes with the event.
        self._last = {"canvas_id": self._canvas.id, "last_response": answer[:1000]}
        self.async_write_ha_state()
        self.hass.bus.async_fire(EVENT_RESPONSE, {"canvas": self._canvas.id, "canvas_name": self._canvas.name, "text": text, "response": answer})
        _LOGGER.debug("Canvas %s answered %d characters", self._canvas.name, len(answer))
