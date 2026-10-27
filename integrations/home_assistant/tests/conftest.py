"""Fixtures: Home Assistant loads custom_components/hivemind from this folder."""

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
import pytest


@pytest.fixture(autouse=True)
async def auto_enable_custom_integrations(hass: HomeAssistant, enable_custom_integrations):
    """Allow loading the integration under test, with the core integration that conversation needs."""
    assert await async_setup_component(hass, "homeassistant", {})
    yield
