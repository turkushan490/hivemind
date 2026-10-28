"""Config flow: HiveMind address and API token; options: which canvases and the button text."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_TOKEN, CONF_URL
from homeassistant.core import callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import HiveMindAuthError, HiveMindClient, HiveMindError, normalize_url
from .const import CONF_BUTTON_TEXT, CONF_CANVASES, DEFAULT_BUTTON_TEXT, DOMAIN


class HiveMindConfigFlow(ConfigFlow, domain=DOMAIN):
    """Adds a HiveMind server."""

    VERSION = 1

    async def _check(self, url: str, token: str) -> dict[str, str]:
        """Tries the address and token; returns the form errors (none when it works)."""
        client = HiveMindClient(async_get_clientsession(self.hass), url, token)
        try:
            await client.canvases()
        except HiveMindAuthError:
            return {"base": "invalid_auth"}
        except HiveMindError:
            return {"base": "cannot_connect"}
        return {}

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = normalize_url(user_input[CONF_URL])
            await self.async_set_unique_id(url)
            errors = await self._check(url, user_input[CONF_TOKEN])
            # The same server again with a working token: update the token instead of refusing.
            self._abort_if_unique_id_configured(updates={CONF_TOKEN: user_input[CONF_TOKEN].strip()} if not errors else None)
            if not errors:
                return self.async_create_entry(title=f"HiveMind ({url.split('://', 1)[-1]})", data={CONF_URL: url, CONF_TOKEN: user_input[CONF_TOKEN].strip()})
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_URL, default=(user_input or {}).get(CONF_URL, "http://")): str,
                    vol.Required(CONF_TOKEN): str,
                }
            ),
            errors=errors,
        )

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """The token was revoked: ask for a new one."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = await self._check(entry.data[CONF_URL], user_input[CONF_TOKEN])
            if not errors:
                return self.async_update_reload_and_abort(entry, data_updates={CONF_TOKEN: user_input[CONF_TOKEN].strip()})
        return self.async_show_form(step_id="reauth_confirm", data_schema=vol.Schema({vol.Required(CONF_TOKEN): str}), errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return HiveMindOptionsFlow()


class HiveMindOptionsFlow(OptionsFlow):
    """Which canvases become agents and buttons, and what a button press sends."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        # The canvas list comes from the loaded server; when it isn't loaded (offline, bad token) there is nothing to pick.
        data = getattr(self.config_entry, "runtime_data", None)
        if data is None:
            return self.async_abort(reason="not_loaded")
        canvases = {c.id: c.name for c in data.canvases}
        chosen = [c for c in self.config_entry.options.get(CONF_CANVASES, []) if c in canvases]
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Optional(CONF_CANVASES, default=chosen): cv.multi_select(canvases),
                    vol.Optional(CONF_BUTTON_TEXT, default=self.config_entry.options.get(CONF_BUTTON_TEXT, DEFAULT_BUTTON_TEXT)): str,
                }
            ),
        )
