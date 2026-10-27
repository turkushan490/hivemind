"""Shared entity bits: one HiveMind device per server."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo

from .api import Canvas
from .const import DOMAIN


def device_info(entry: ConfigEntry, url: str) -> DeviceInfo:
    """The HiveMind server as a service device."""
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name=entry.title,
        manufacturer="HiveMind",
        model="Self-hosted AI canvases",
        entry_type=DeviceEntryType.SERVICE,
        configuration_url=url,
    )


def unique_id(entry: ConfigEntry, canvas: Canvas, kind: str) -> str:
    """Stable per server, canvas and entity kind."""
    return f"{entry.entry_id}_{canvas.id}_{kind}"
