"""Assist conversation agents: every canvas can answer voice and chat commands."""

from __future__ import annotations

from collections import OrderedDict
from typing import Literal

from homeassistant.components import conversation
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import ulid

from . import HiveMindConfigEntry
from .api import Canvas, HiveMindAuthError, HiveMindError
from .entity import device_info, unique_id

# Earlier turns sent with each question, per conversation (HiveMind fills {{history}} with them).
MAX_TURNS = 10
MAX_CONVERSATIONS = 50


async def async_setup_entry(hass: HomeAssistant, entry: HiveMindConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    """One agent per shown canvas; pick it in Settings → Voice assistants."""
    async_add_entities(HiveMindAgent(entry, canvas) for canvas in entry.runtime_data.shown(entry))


class HiveMindAgent(conversation.ConversationEntity):
    """Sends what was said to a canvas through /v1/chat/completions and speaks its final answer."""

    _attr_has_entity_name = True

    def __init__(self, entry: HiveMindConfigEntry, canvas: Canvas) -> None:
        self._entry = entry
        self._canvas = canvas
        self._attr_name = canvas.name
        self._attr_unique_id = unique_id(entry, canvas, "conversation")
        self._attr_device_info = device_info(entry, entry.runtime_data.client.url)
        self._history: OrderedDict[str, list[dict[str, str]]] = OrderedDict()

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """The canvas's models decide; any language goes."""
        return MATCH_ALL

    async def async_process(self, user_input: conversation.ConversationInput) -> conversation.ConversationResult:
        """Runs the canvas with the spoken or typed text, plus the earlier turns of this conversation."""
        conversation_id = user_input.conversation_id or ulid.ulid_now()
        history = self._history.get(conversation_id, [])
        response = intent.IntentResponse(language=user_input.language)
        try:
            answer = await self._entry.runtime_data.client.run(self._canvas.id, user_input.text, history)
            response.async_set_speech(answer.strip() or "The canvas gave an empty answer.")
            turns = [*history, {"role": "user", "content": user_input.text}, {"role": "assistant", "content": answer}]
            self._history[conversation_id] = turns[-MAX_TURNS * 2 :]
            self._history.move_to_end(conversation_id)
            while len(self._history) > MAX_CONVERSATIONS:
                self._history.popitem(last=False)
        except HiveMindError as err:
            if isinstance(err, HiveMindAuthError):
                self._entry.async_start_reauth(self.hass)
            response.async_set_error(intent.IntentResponseErrorCode.UNKNOWN, f"HiveMind could not answer: {err}")
        return conversation.ConversationResult(response=response, conversation_id=conversation_id)
